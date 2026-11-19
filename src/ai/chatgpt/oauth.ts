import { AiError, AiHttp } from "../types";
import {
  CallbackHost,
  CallbackPath,
  DefaultCallbackPort,
  DiscoveryUrl,
  Issuer
} from "./constants";

// ---------------------------------------------------------------------------
// Encoding helpers

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** A fresh PKCE pair with the S256 method. */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// ---------------------------------------------------------------------------
// Discovery and ID token validation

interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

let discoveryCache: Discovery | null = null;

export async function getDiscovery(http: AiHttp): Promise<Discovery> {
  if (discoveryCache) return discoveryCache;
  const res = await http({ url: DiscoveryUrl, method: "GET" });
  if (res.status !== 200) {
    throw new AiError(
      `Could not load OpenAI's sign-in configuration (${res.status}).`
    );
  }
  const doc = JSON.parse(res.text) as Discovery;
  if (doc.issuer !== Issuer || !doc.jwks_uri) {
    throw new AiError("OpenAI's sign-in configuration looks wrong.");
  }
  discoveryCache = doc;
  return doc;
}

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  sid?: string;
  email?: string;
  email_verified?: boolean;
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
}

// Signature algorithms the plugin can check. The docs do not name the one
// OpenAI uses, so an unknown algorithm fails closed rather than skipping
// the check.
function getAlgorithm(
  alg: string,
  jwk: Jwk
): {
  importParams: RsaHashedImportParams | EcKeyImportParams;
  verifyParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  key: JsonWebKey;
} | null {
  if (jwk.kty === "RSA" && jwk.n && jwk.e) {
    const key = { kty: "RSA", n: jwk.n, e: jwk.e };
    if (alg === "RS256") {
      return {
        importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        verifyParams: "RSASSA-PKCS1-v1_5",
        key
      };
    }
    if (alg === "PS256") {
      return {
        importParams: { name: "RSA-PSS", hash: "SHA-256" },
        verifyParams: { name: "RSA-PSS", saltLength: 32 },
        key
      };
    }
  }
  if (
    jwk.kty === "EC" &&
    alg === "ES256" &&
    jwk.crv === "P-256" &&
    jwk.x &&
    jwk.y
  ) {
    return {
      importParams: { name: "ECDSA", namedCurve: "P-256" },
      verifyParams: { name: "ECDSA", hash: "SHA-256" },
      key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }
    };
  }
  return null;
}

/**
 * Validate an ID token as the docs require: signature against OpenAI's
 * published keys, exact issuer, audience equal to the issued client ID,
 * expiry with five seconds of tolerance, the nonce of this sign-in attempt,
 * and a non-empty subject.
 */
export async function validateIdToken(
  http: AiHttp,
  idToken: string,
  clientId: string,
  nonce: string
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new AiError("OpenAI returned a malformed ID token.");
  }
  const header = decodeJson<{ alg: string; kid?: string }>(parts[0]);
  const claims = decodeJson<IdTokenClaims>(parts[1]);

  const discovery = await getDiscovery(http);
  const jwksRes = await http({ url: discovery.jwks_uri, method: "GET" });
  if (jwksRes.status !== 200) {
    throw new AiError("Could not load OpenAI's signing keys.");
  }
  const { keys } = JSON.parse(jwksRes.text) as { keys: Jwk[] };
  const candidates = keys.filter(k => !header.kid || k.kid === header.kid);

  let verified = false;
  for (const jwk of candidates) {
    const algorithm = getAlgorithm(header.alg, jwk);
    if (!algorithm) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      algorithm.key,
      algorithm.importParams,
      false,
      ["verify"]
    );
    verified = await crypto.subtle.verify(
      algorithm.verifyParams,
      key,
      base64UrlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (verified) break;
  }
  if (!verified) {
    throw new AiError("OpenAI's ID token signature could not be verified.");
  }

  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== Issuer) {
    throw new AiError("The ID token came from an unexpected issuer.");
  }
  if (!audiences.includes(clientId)) {
    throw new AiError("The ID token was issued to a different client.");
  }
  if (typeof claims.exp !== "number" || claims.exp + 5 < now) {
    throw new AiError("The ID token has expired.");
  }
  if (typeof claims.iat !== "number") {
    throw new AiError("The ID token has no issue time.");
  }
  if (claims.nonce !== nonce) {
    throw new AiError("The ID token does not belong to this sign-in.");
  }
  if (typeof claims.sub !== "string" || !claims.sub) {
    throw new AiError("The ID token has no account identifier.");
  }
  if (
    claims.sid !== undefined &&
    (typeof claims.sid !== "string" || !claims.sid)
  ) {
    throw new AiError("The ID token has an invalid session identifier.");
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Loopback callback listener (desktop only)

// The parts of Node's http module the listener uses, typed here so the
// bundle never imports a Node built-in; the module is required at runtime on
// desktop only
interface NodeRequest {
  method?: string;
  url?: string;
}

interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

interface NodeServer {
  listen(port: number, host: string): void;
  address(): { port: number } | string | null;
  close(): void;
  once(event: string, listener: (error?: Error) => void): void;
  off(event: string, listener: (error?: Error) => void): void;
}

interface NodeHttp {
  createServer(
    handler: (req: NodeRequest, res: NodeResponse) => void
  ): NodeServer;
}

export interface LoopbackListener {
  redirectUri: string;
  callback: Promise<URLSearchParams>;
  close(): void;
}

const callbackPage = `<!doctype html><html><head><meta charset="utf-8"><title>LanguageTool Copilot</title></head><body style="font-family: sans-serif; padding: 2em"><p>Sign-in finished. You can close this tab and return to Obsidian.</p></body></html>`;

/**
 * Start an HTTP listener on 127.0.0.1 for the OAuth redirect. Node's http
 * module only exists in the desktop app, so it is loaded here, on demand,
 * rather than imported at the top of the bundle where it would break the
 * plugin on mobile.
 */
export async function startLoopbackListener(
  timeoutMs: number
): Promise<LoopbackListener> {
  const nodeRequire = (window as unknown as { require?: NodeRequire }).require;
  if (!nodeRequire) {
    throw new AiError("Signing in with ChatGPT needs the desktop app.");
  }
  const http = nodeRequire("http") as NodeHttp;

  let resolveCallback: (params: URLSearchParams) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  const callback = new Promise<URLSearchParams>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = http.createServer(
    (req: NodeRequest, res: NodeResponse) => {
      const url = new URL(req.url ?? "/", `http://${CallbackHost}`);
      if (req.method !== "GET" || url.pathname !== CallbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(callbackPage);
      resolveCallback(url.searchParams);
    }
  );

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, CallbackHost);
    });

  let port: number;
  try {
    port = await listen(DefaultCallbackPort);
  } catch {
    // Another app holds the default port; any free port works as long as
    // the same redirect URI is used for the code exchange
    port = await listen(0);
  }

  const timer = window.setTimeout(() => {
    rejectCallback(
      new AiError("Sign-in timed out. Start it again from the settings.")
    );
  }, timeoutMs);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    rejectCallback(new AiError("Sign-in was cancelled."));
    server.close();
  };
  void callback.then(close, close);

  return {
    redirectUri: `http://${CallbackHost}:${port}${CallbackPath}`,
    callback,
    close
  };
}
