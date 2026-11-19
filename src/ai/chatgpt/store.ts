/**
 * Device-local storage for the ChatGPT sign-in, backed by Obsidian's
 * SecretStorage. Nothing here is ever written to data.json, so none of it
 * syncs to other devices or ends up in vault backups.
 */
export interface SecretStore {
  get(id: string): string | null;
  set(id: string, value: string): void;
}

const HostIdSecret = "languagetool-copilot-chatgpt-host-id";
const RegistrationSecret = "languagetool-copilot-chatgpt-registration";
const SessionSecret = "languagetool-copilot-chatgpt-session";

// The issued client and the account it belongs to. Kept across sign-out, as
// the docs require: signing out ends the session, not the registration.
export interface ChatgptRegistration {
  clientId: string;
  subject: string;
  // Only kept when the ID token marked it verified; sent as login_hint
  email?: string;
}

export interface ChatgptSession {
  clientId: string;
  subject: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  // Epoch milliseconds
  expiresAt: number;
  scopes: string[];
  savedAt: number;
}

function readJson<T>(store: SecretStore, id: string): T | null {
  const raw = store.get(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function newHostId(): string {
  // Opaque and not derived from anything about the user, per the docs'
  // urn:uuid format with a version 4 UUID
  return `urn:uuid:${crypto.randomUUID()}`;
}

export class ChatgptStore {
  public constructor(private readonly secrets: SecretStore) {}

  /** The host ID, created once before the first sign-in and then reused. */
  public getOrCreateHostId(): string {
    const existing = this.secrets.get(HostIdSecret);
    if (existing) return existing;
    const id = newHostId();
    this.secrets.set(HostIdSecret, id);
    return id;
  }

  public getRegistration(): ChatgptRegistration | null {
    return readJson<ChatgptRegistration>(this.secrets, RegistrationSecret);
  }

  public setRegistration(registration: ChatgptRegistration): void {
    this.secrets.set(RegistrationSecret, JSON.stringify(registration));
  }

  public getSession(): ChatgptSession | null {
    return readJson<ChatgptSession>(this.secrets, SessionSecret);
  }

  // Access token, refresh token, expiry and scopes are always replaced
  // together in one write
  public setSession(session: ChatgptSession): void {
    this.secrets.set(SessionSecret, JSON.stringify(session));
  }

  // SecretStorage has no delete call; an empty value reads as "not set"
  public clearSession(): void {
    this.secrets.set(SessionSecret, "");
  }

  /** Forget everything, including the registration and the host ID. */
  public clearAll(): void {
    this.clearSession();
    this.secrets.set(RegistrationSecret, "");
    this.secrets.set(HostIdSecret, "");
  }
}
