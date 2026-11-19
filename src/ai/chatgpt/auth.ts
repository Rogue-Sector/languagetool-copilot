import { AiError, AiHttp, AiHttpResponse, SignInAgainError } from "../types";
import {
  AgentName,
  ApiResource,
  AuthorizeUrl,
  DeadRefreshTokenErrors,
  DynamicClientId,
  PlanScope,
  Scopes,
  TokenUrl
} from "./constants";
import {
  createPkce,
  formBody,
  getDiscovery,
  randomToken,
  startLoopbackListener,
  validateIdToken
} from "./oauth";
import { ChatgptSession, ChatgptStore } from "./store";

const SignInTimeoutMs = 5 * 60 * 1000;
// Refresh this long before the access token expires. The docs leave the
// margin to the app.
const RefreshMarginMs = 5 * 60 * 1000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(res: AiHttpResponse): TokenResponse {
  try {
    return JSON.parse(res.text) as TokenResponse;
  } catch {
    return {};
  }
}

export interface ChatgptStatus {
  signedIn: boolean;
  email?: string;
  // False when the user signed in without granting plan usage
  planEnabled: boolean;
}

/**
 * The ChatGPT sign-in: registration, the PKCE authorization code flow over a
 * loopback redirect, token refresh, and sign-out.
 */
export class ChatgptAuth {
  private refreshPromise: Promise<ChatgptSession> | null = null;
  private pendingSignIn: { cancel: () => void } | null = null;

  public constructor(
    private readonly http: AiHttp,
    private readonly store: ChatgptStore,
    private readonly openBrowser: (url: string) => void
  ) {}

  public getStatus(): ChatgptStatus {
    const session = this.store.getSession();
    if (!session) {
      return { signedIn: false, planEnabled: false };
    }
    return {
      signedIn: true,
      email: session.email,
      planEnabled: session.scopes.includes(PlanScope)
    };
  }

  public isSigningIn(): boolean {
    return this.pendingSignIn !== null;
  }

  public cancelSignIn(): void {
    this.pendingSignIn?.cancel();
  }

  /**
   * Run the browser sign-in. Resolves once tokens are validated and stored.
   * Returns whether this was the first sign-in on this device.
   */
  public async signIn(): Promise<void> {
    if (this.pendingSignIn) {
      throw new AiError("A sign-in is already in progress.");
    }

    // The host ID must exist before the first sign-in and is reused after
    const hostId = this.store.getOrCreateHostId();
    const registration = this.store.getRegistration();
    const previousSession = this.store.getSession();
    const isNewRegistration = !registration;
    const clientId = registration?.clientId ?? DynamicClientId;

    // Fresh state, nonce and PKCE for every attempt
    const state = randomToken();
    const nonce = randomToken();
    const pkce = await createPkce();

    // The listener must be up before the browser opens
    const listener = await startLoopbackListener(SignInTimeoutMs);
    this.pendingSignIn = { cancel: () => listener.close() };

    try {
      const params: Record<string, string> = {
        client_id: clientId,
        ext_agent_host_id: hostId,
        response_type: "code",
        redirect_uri: listener.redirectUri,
        scope: Scopes,
        resource: ApiResource,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: pkce.challenge
      };
      if (isNewRegistration) {
        params.agent_name_hint = AgentName;
      } else {
        // Skip the account picker for a returning account. The ID token is
        // only kept while signed in, so it is absent after a sign-out.
        if (previousSession?.idToken) {
          params.id_token_hint = previousSession.idToken;
        }
        if (registration.email) {
          params.login_hint = registration.email;
        }
      }

      this.openBrowser(`${AuthorizeUrl}?${new URLSearchParams(params)}`);

      const callback = await listener.callback;

      // State first, before looking at an error or a code
      if (callback.get("state") !== state) {
        throw new AiError(
          "The sign-in response did not match this request. Try again."
        );
      }
      const error = callback.get("error");
      if (error) {
        throw new AiError(
          error === "access_denied"
            ? "Sign-in was cancelled in the browser."
            : `Sign-in failed (${error}).`
        );
      }
      const code = callback.get("code");
      if (!code) {
        throw new AiError("The sign-in response had no authorization code.");
      }

      const returnedClientId = callback.get("client_id");
      let issuedClientId: string;
      if (isNewRegistration) {
        if (!returnedClientId || returnedClientId === DynamicClientId) {
          throw new AiError(
            "OpenAI did not finish registering this app. Try signing in again."
          );
        }
        issuedClientId = returnedClientId;
      } else {
        if (returnedClientId && returnedClientId !== clientId) {
          throw new AiError(
            "The sign-in response named a different app registration. Try again."
          );
        }
        issuedClientId = clientId;
      }

      const tokenRes = await this.http({
        url: TokenUrl,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        headers: { Accept: "application/json" },
        body: formBody({
          grant_type: "authorization_code",
          client_id: issuedClientId,
          code,
          code_verifier: pkce.verifier,
          redirect_uri: listener.redirectUri,
          resource: ApiResource
        })
      });
      const tokens = parseTokenResponse(tokenRes);
      if (tokenRes.status !== 200 || !tokens.access_token || !tokens.id_token) {
        // A new registration still counts even when the exchange fails, so
        // the next attempt reuses the issued client ID
        if (isNewRegistration && tokens.error === "invalid_grant") {
          this.store.setRegistration({
            clientId: issuedClientId,
            subject: ""
          });
        }
        throw new AiError(
          `Exchanging the sign-in code failed (${tokens.error ??
            tokenRes.status}). Try again.`
        );
      }

      const claims = await validateIdToken(
        this.http,
        tokens.id_token,
        issuedClientId,
        nonce
      );

      // A returning account must be the same account as the registration
      if (registration?.subject && registration.subject !== claims.sub) {
        throw new AiError(
          "You signed in with a different ChatGPT account than the one registered on this device. Use \"Forget this device\" first to switch accounts."
        );
      }

      const email =
        claims.email && claims.email_verified === true
          ? claims.email
          : undefined;
      const scopes = (tokens.scope ?? "").split(" ").filter(Boolean);

      this.store.setRegistration({
        clientId: issuedClientId,
        subject: claims.sub,
        email
      });
      this.store.setSession({
        clientId: issuedClientId,
        subject: claims.sub,
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        scopes,
        savedAt: Date.now()
      });

      if (!scopes.includes(PlanScope)) {
        throw new AiError(
          "Signed in, but ChatGPT plan usage was not granted, so alternatives cannot use your plan. Sign in again and allow plan usage."
        );
      }
    } finally {
      listener.close();
      this.pendingSignIn = null;
    }
  }

  /**
   * A usable access token, refreshed when it is about to expire or when the
   * caller saw a 401 (force).
   */
  public async getAccessToken(force = false): Promise<string> {
    const session = this.store.getSession();
    if (!session) {
      throw new AiError(
        "Not signed in to ChatGPT. Choose \"Continue with ChatGPT\" in the settings."
      );
    }
    if (!session.scopes.includes(PlanScope)) {
      throw new AiError(
        "ChatGPT plan usage was not granted at sign-in. Sign out and sign in again to allow it."
      );
    }
    if (!force && session.expiresAt - RefreshMarginMs > Date.now()) {
      return session.accessToken;
    }
    const refreshed = await this.refresh(session);
    return refreshed.accessToken;
  }

  // Refresh tokens rotate on every use, so concurrent callers share a single
  // refresh instead of racing each other
  private refresh(session: ChatgptSession): Promise<ChatgptSession> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh(session).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(session: ChatgptSession): Promise<ChatgptSession> {
    if (!session.refreshToken) {
      this.store.clearSession();
      throw new SignInAgainError();
    }
    const res = await this.http({
      url: TokenUrl,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      headers: { Accept: "application/json" },
      body: formBody({
        grant_type: "refresh_token",
        client_id: session.clientId,
        refresh_token: session.refreshToken,
        resource: ApiResource
      })
    });
    const tokens = parseTokenResponse(res);

    if (res.status !== 200 || !tokens.access_token) {
      if (tokens.error && DeadRefreshTokenErrors.includes(tokens.error)) {
        // The token can never work again: drop it and ask for a new sign-in
        this.store.clearSession();
        throw new SignInAgainError();
      }
      if (tokens.error === "invalid_client") {
        throw new AiError(
          "OpenAI no longer recognises this app registration. Use \"Forget this device\" and sign in again."
        );
      }
      // Temporary failures keep the credentials
      throw new AiError(
        `Refreshing the ChatGPT sign-in failed (${tokens.error ??
          res.status}). Try again in a moment.`
      );
    }

    const next: ChatgptSession = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      idToken: tokens.id_token ?? session.idToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: tokens.scope
        ? tokens.scope.split(" ").filter(Boolean)
        : session.scopes,
      savedAt: Date.now()
    };
    this.store.setSession(next);
    return next;
  }

  /** The session cannot be used any more, e.g. after a confirmed 401. */
  public dropSession(): void {
    this.store.clearSession();
  }

  /**
   * Sign out: revoke the refresh token, then clear the tokens on this
   * device. The registration and host ID stay, as the docs require, so the
   * next sign-in reuses them. Returns whether revocation was confirmed.
   */
  public async signOut(): Promise<boolean> {
    const session = this.store.getSession();
    let revoked = !session?.refreshToken;
    if (session?.refreshToken) {
      revoked = await this.revoke(session.refreshToken, session.clientId);
    }
    this.store.clearSession();
    return revoked;
  }

  /** Sign out and also forget the registration and the host ID. */
  public async forgetDevice(): Promise<boolean> {
    const revoked = await this.signOut();
    this.store.clearAll();
    return revoked;
  }

  private async revoke(token: string, clientId: string): Promise<boolean> {
    let endpoint: string | undefined;
    try {
      endpoint = (await getDiscovery(this.http)).revocation_endpoint;
    } catch {
      return false;
    }
    if (!endpoint) return false;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.http({
          url: endpoint,
          method: "POST",
          contentType: "application/x-www-form-urlencoded",
          body: formBody({
            token,
            token_type_hint: "refresh_token",
            client_id: clientId
          })
        });
        if (res.status === 200) return true;
        if (res.status < 500) return false;
      } catch {
        // Network failure: retry below
      }
      await new Promise(resolve => window.setTimeout(resolve, 500 * 2 ** attempt));
    }
    return false;
  }
}
