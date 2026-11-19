import { buildInstructions, buildUserMessage, parseAlternatives } from "../prompt";
import {
  AiError,
  AiHttp,
  AiHttpResponse,
  AiProvider,
  AlternativesRequest,
  SignInAgainError
} from "../types";
import { ChatgptAuth } from "./auth";
import { ManageUsageUrl, ModelsUrl, ResponsesUrl } from "./constants";

interface ApiErrorBody {
  error?: { code?: string; message?: string; param?: string };
  detail?: string;
}

interface StreamEvent {
  type?: string;
  delta?: string;
  response?: { error?: { code?: string; message?: string } };
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
}

function requestIdOf(res: AiHttpResponse): string | undefined {
  return res.headers["x-request-id"] ?? res.headers["openai-request-id"];
}

// User-facing messages for the plan errors in the docs' errors-and-recovery
// page
function describePlanError(
  code: string | undefined,
  fallback: string,
  requestId?: string
): AiError {
  switch (code) {
    case "subscription_sharing_user_not_eligible":
      return new AiError(
        "This ChatGPT account is not eligible to use its plan in other apps.",
        requestId
      );
    case "subscription_sharing_usage_limit_exceeded":
      return new AiError(
        `You have reached your ChatGPT plan's usage limit. Manage usage at ${ManageUsageUrl}.`,
        requestId
      );
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return new AiError(
        "ChatGPT plan usage is temporarily unavailable. Try again shortly.",
        requestId
      );
    case "subscription_sharing_unsupported_capability":
      return new AiError(
        "ChatGPT does not support this request (often the chosen model). Check the model name in the settings.",
        requestId
      );
    case "subscription_sharing_invalid_user":
      return new AiError(
        "ChatGPT did not accept this sign-in. Try again; if it keeps failing, sign out and sign in again.",
        requestId
      );
    default:
      return new AiError(fallback, requestId);
  }
}

function describeHttpError(res: AiHttpResponse): AiError {
  let body: ApiErrorBody = {};
  try {
    body = JSON.parse(res.text) as ApiErrorBody;
  } catch {
    // Non-JSON body: only the status is useful
  }
  const code = body.error?.code;
  let fallback = `ChatGPT request failed (${res.status}${
    code ? ` ${code}` : ""
  }).`;
  if (res.status === 403 && !code) {
    fallback =
      "ChatGPT refused the request. Plan usage may not be available in your region or for this account.";
  } else if (res.status === 503 && !code) {
    fallback = "ChatGPT plan usage is unavailable right now. Try again later.";
  }
  return describePlanError(code, fallback, requestIdOf(res));
}

/**
 * Read a server-sent event stream that arrived in one piece. Only
 * response.completed counts as success; a failed, incomplete or truncated
 * stream is an error.
 */
export function readResponseStream(text: string, requestId?: string): string {
  let output = "";
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case "response.output_text.delta":
        output += event.delta ?? "";
        break;
      case "response.completed":
        return output;
      case "response.failed": {
        const error = event.response?.error;
        throw describePlanError(
          error?.code,
          `ChatGPT could not finish the request${
            error?.code ? ` (${error.code})` : ""
          }.`,
          requestId
        );
      }
      case "response.incomplete":
        throw new AiError("ChatGPT stopped before finishing.", requestId);
      case "error": {
        const code = event.error?.code ?? event.code;
        throw describePlanError(
          code,
          `ChatGPT reported an error${code ? ` (${code})` : ""}.`,
          requestId
        );
      }
    }
  }
  throw new AiError("The ChatGPT response ended unexpectedly.", requestId);
}

interface ModelEntry {
  slug?: string;
  display_name?: string;
  visibility?: string;
}

export class ChatgptProvider implements AiProvider {
  public readonly id = "chatgpt";
  public readonly destination = "OpenAI (api.openai.com) using your ChatGPT plan";
  private modelsCache: ModelEntry[] | null = null;

  public constructor(
    private readonly http: AiHttp,
    private readonly auth: ChatgptAuth,
    private readonly getModel: () => string
  ) {}

  public clearModelCache(): void {
    this.modelsCache = null;
  }

  /** Models the signed-in account can use, in the server's order. */
  public async listModels(): Promise<ModelEntry[]> {
    if (this.modelsCache) return this.modelsCache;
    const token = await this.auth.getAccessToken();
    const res = await this.http({
      url: ModelsUrl,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.status !== 200) {
      throw describeHttpError(res);
    }
    const body = JSON.parse(res.text) as { models?: ModelEntry[] };
    this.modelsCache = (body.models ?? []).filter(
      m => m.visibility === "list" && m.slug
    );
    return this.modelsCache;
  }

  private async resolveModel(): Promise<string> {
    const configured = this.getModel().trim();
    if (configured) return configured;
    const first = (await this.listModels())[0]?.slug;
    if (!first) {
      throw new AiError(
        "No ChatGPT models are available to this account. Enter a model name in the settings."
      );
    }
    return first;
  }

  public async generate(request: AlternativesRequest): Promise<string[]> {
    const model = await this.resolveModel();
    const body = JSON.stringify({
      model,
      instructions: buildInstructions(request),
      input: [{ role: "user", content: buildUserMessage(request) }],
      store: false,
      stream: true
    });

    const send = async (token: string) =>
      this.http({
        url: ResponsesUrl,
        method: "POST",
        contentType: "application/json",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream"
        },
        body
      });

    let res = await send(await this.auth.getAccessToken());
    if (res.status === 401) {
      // Refresh once and retry; a second 401 means the sign-in is unusable
      res = await send(await this.auth.getAccessToken(true));
      if (res.status === 401) {
        this.auth.dropSession();
        throw new SignInAgainError(
          "ChatGPT no longer accepts this sign-in. Sign in again in the settings."
        );
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw describeHttpError(res);
    }

    const text = readResponseStream(res.text, requestIdOf(res));
    return parseAlternatives(text, request);
  }
}
