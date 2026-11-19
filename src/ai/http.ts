import { requestUrl } from "obsidian";
import { AiError, AiHttp } from "./types";

/**
 * Default transport for the AI feature: Obsidian's requestUrl, which runs
 * outside the page on desktop and mobile, so no CORS rules apply. Status
 * codes are returned rather than thrown so each provider can map them to its
 * own error messages.
 */
export const obsidianHttp: AiHttp = async request => {
  try {
    const res = await requestUrl({ ...request, throw: false });
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    return { status: res.status, text: res.text, headers };
  } catch (e) {
    // Network failures carry no response. The URL is safe to name; request
    // bodies and headers are never included because they hold credentials.
    const host = new URL(request.url).host;
    console.error(
      `LanguageTool Copilot: request to ${host} failed:`,
      e instanceof Error ? e.message : String(e)
    );
    throw new AiError(`Could not reach ${host}. Check your connection.`);
  }
};
