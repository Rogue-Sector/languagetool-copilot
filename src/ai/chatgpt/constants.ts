// Endpoints and parameters of OpenAI's "Sign in with ChatGPT" flow for
// open-source apps, as documented at
// https://developers.openai.com/siwc/token-sharing-open-source (read November
// 2026). Nothing here is guessed: values not on those pages (the revocation
// endpoint and JWKS URI) are read from the issuer's discovery document.

export const Issuer = "https://auth.openai.com";
export const DiscoveryUrl = `${Issuer}/.well-known/openid-configuration`;
export const AuthorizeUrl = `${Issuer}/api/accounts/authorize`;
export const TokenUrl = `${Issuer}/api/accounts/oauth/token`;

export const ApiResource = "https://api.openai.com/v1";
export const ResponsesUrl = `${ApiResource}/responses`;
export const ModelsUrl = `${ApiResource}/models`;

// Placeholder client ID for the first registration of this host. The issued
// ID from the callback replaces it, and it is never used for token requests.
export const DynamicClientId = "dynamic_agent_client";
export const AgentName = "LanguageTool Copilot";

export const PlanScope = "chatgpt.tokens.use.direct";
export const Scopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  PlanScope
].join(" ");

// Loopback redirect: 127.0.0.1 (never localhost) and a fixed path. Only the
// port may change between sign-ins, so a busy default port falls back to any
// free one.
export const CallbackHost = "127.0.0.1";
export const CallbackPath = "/auth/callback";
export const DefaultCallbackPort = 1455;

export const ManageUsageUrl = "https://chatgpt.com/settings/usage";

// Refresh errors that mean the refresh token can never work again
export const DeadRefreshTokenErrors = [
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused"
];
