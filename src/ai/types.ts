import { RequestUrlParam } from "obsidian";

export type AiProviderId = "off" | "anthropic" | "chatgpt";

/**
 * What one request for alternatives sends to a provider: the passage to
 * rewrite and, when the request comes from a LanguageTool match, the
 * checker's message. Nothing else from the note is ever included.
 */
export interface AlternativesRequest {
  text: string;
  issue?: string;
  count: number;
}

export interface AiProvider {
  readonly id: Exclude<AiProviderId, "off">;
  // Shown in the popover and the settings so the user always knows where
  // their text goes
  readonly destination: string;
  generate(request: AlternativesRequest): Promise<string[]>;
}

export interface AiHttpResponse {
  status: number;
  text: string;
  headers: Record<string, string>;
}

/**
 * Every network request the AI feature makes goes through one function of
 * this shape. The plugin's default wraps Obsidian's requestUrl; the e2e tests
 * swap in a mock so no request ever leaves the machine.
 */
export type AiHttp = (request: RequestUrlParam) => Promise<AiHttpResponse>;

/**
 * An error whose message is safe and useful to show the user as is. Messages
 * never contain keys or tokens.
 */
export class AiError extends Error {
  public constructor(message: string, public readonly requestId?: string) {
    super(message);
    this.name = "AiError";
  }
}

/**
 * The stored ChatGPT credentials are unusable (revoked, expired or rotated
 * away), so the user has to sign in again.
 */
export class SignInAgainError extends AiError {
  public constructor(message?: string) {
    super(
      message ??
        "Your ChatGPT sign-in has expired. Sign in again under Settings, LanguageTool Copilot, AI alternatives."
    );
    this.name = "SignInAgainError";
  }
}
