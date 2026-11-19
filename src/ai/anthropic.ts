import {
  alternativesSchema,
  buildInstructions,
  buildUserMessage,
  parseAlternatives
} from "./prompt";
import {
  AiError,
  AiHttp,
  AiHttpResponse,
  AiProvider,
  AlternativesRequest
} from "./types";

// Request format per Anthropic's Messages API docs (platform.claude.com,
// read November 2026)
const MessagesUrl = "https://api.anthropic.com/v1/messages";
const AnthropicVersion = "2026-10-21";

// Small and fast, which suits rewriting a single sentence. Users can enter
// any other model ID in the settings.
export const DefaultAnthropicModel = "claude-haiku-5-5";

// Leaves room for adaptive thinking before the short JSON reply
const MaxTokens = 2048;

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessage {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
}

interface AnthropicErrorBody {
  error?: { type?: string; message?: string };
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function describeError(res: AiHttpResponse): AiError {
  const requestId = res.headers["request-id"];
  const body = parseJson<AnthropicErrorBody>(res.text);
  const type = body?.error?.type;
  const detail = body?.error?.message;
  let message: string;
  switch (res.status) {
    case 401:
      message =
        "Anthropic rejected the API key. Check the key selected in the settings.";
      break;
    case 402:
      message = "Anthropic reported a billing problem with this API key.";
      break;
    case 403:
      message = "This Anthropic API key is not allowed to use that model.";
      break;
    case 404:
      message =
        "Anthropic does not know that model. Check the model name in the settings.";
      break;
    case 429:
      message =
        "Anthropic rate limit or spend limit reached. Try again later.";
      break;
    case 529:
      message = "Anthropic is overloaded right now. Try again in a moment.";
      break;
    default:
      message = `Anthropic request failed (${res.status}${
        type ? ` ${type}` : ""
      })${detail ? `: ${detail}` : "."}`;
  }
  return new AiError(message, requestId);
}

export class AnthropicProvider implements AiProvider {
  public readonly id = "anthropic";
  public readonly destination = "Anthropic (api.anthropic.com)";

  public constructor(
    private readonly http: AiHttp,
    private readonly getApiKey: () => string | null,
    private readonly getModel: () => string
  ) {}

  public async generate(request: AlternativesRequest): Promise<string[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new AiError(
        "No Anthropic API key is set on this device. Add one in the settings."
      );
    }

    const res = await this.http({
      url: MessagesUrl,
      method: "POST",
      contentType: "application/json",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": AnthropicVersion
      },
      body: JSON.stringify({
        model: this.getModel() || DefaultAnthropicModel,
        max_tokens: MaxTokens,
        system: buildInstructions(request),
        messages: [{ role: "user", content: buildUserMessage(request) }],
        output_config: {
          format: { type: "json_schema", schema: alternativesSchema }
        }
      })
    });

    if (res.status < 200 || res.status >= 300) {
      throw describeError(res);
    }

    const message = parseJson<AnthropicMessage>(res.text);
    if (message?.stop_reason === "refusal") {
      throw new AiError("The model declined to rewrite this passage.");
    }
    // Adaptive thinking can put a thinking block first, so collect every
    // text block rather than reading content[0]
    const text = (message?.content ?? [])
      .filter(block => block.type === "text" && block.text)
      .map(block => block.text)
      .join("");
    return parseAlternatives(text, request);
  }
}
