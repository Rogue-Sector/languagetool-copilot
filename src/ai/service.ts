import { App, TFile, editorInfoField, requireApiVersion } from "obsidian";
import { EditorView } from "@codemirror/view";
import QuickLRU from "quick-lru";
import { AnthropicProvider } from "./anthropic";
import { ChatgptAuth } from "./chatgpt/auth";
import { ChatgptProvider } from "./chatgpt/provider";
import { ChatgptStore, SecretStore } from "./chatgpt/store";
import { obsidianHttp } from "./http";
import { AiError, AiHttp, AiProvider, AlternativesRequest } from "./types";
import { LanguageToolPluginSettings } from "../SettingsTab";
import { isDocumentIgnored } from "../helpers";

export const DefaultAnthropicKeySecretName = "languagetool-copilot-anthropic-key";

export interface AlternativesHost {
  app: App;
  settings: LanguageToolPluginSettings;
  isSecretStorageAvailable(): boolean;
}

/**
 * Entry point for AI alternatives: picks the configured provider, enforces
 * the privacy gates (provider off, lt-ignore notes) before anything is sent,
 * and caches results per passage so reopening a popover does not request
 * again.
 */
export class AlternativesService {
  /**
   * Transport for every AI request, including sign-in and token refresh.
   * Replaced by the e2e tests with a mock.
   */
  public http: AiHttp = obsidianHttp;

  public readonly chatgptAuth: ChatgptAuth | null;
  private readonly chatgptProvider: ChatgptProvider | null;
  private readonly anthropicProvider: AnthropicProvider;
  private readonly cache = new QuickLRU<string, Promise<string[]>>({
    maxSize: 100
  });

  public constructor(private readonly host: AlternativesHost) {
    const http: AiHttp = request => this.http(request);
    const secrets = this.getSecretStore();

    this.anthropicProvider = new AnthropicProvider(
      http,
      () => {
        const name = this.host.settings.aiAnthropicKeySecretName;
        if (!name || !secrets) return null;
        return secrets.get(name) || null;
      },
      () => this.host.settings.aiAnthropicModel.trim()
    );

    if (secrets) {
      this.chatgptAuth = new ChatgptAuth(
        http,
        new ChatgptStore(secrets),
        url => {
          window.open(url);
        }
      );
      this.chatgptProvider = new ChatgptProvider(
        http,
        this.chatgptAuth,
        () => this.host.settings.aiChatgptModel
      );
    } else {
      this.chatgptAuth = null;
      this.chatgptProvider = null;
    }
  }

  // Keys and tokens live only in SecretStorage. Without it (Obsidian older
  // than 1.11.4) the AI feature is unavailable rather than falling back to
  // data.json.
  private getSecretStore(): SecretStore | null {
    if (!requireApiVersion("1.11.4") || !this.host.isSecretStorageAvailable()) {
      return null;
    }
    const app = this.host.app;
    return {
      get: id =>
        requireApiVersion("1.11.4") ? app.secretStorage.getSecret(id) : null,
      set: (id, value) => {
        if (requireApiVersion("1.11.4")) {
          app.secretStorage.setSecret(id, value);
        }
      }
    };
  }

  public getProvider(): AiProvider | null {
    switch (this.host.settings.aiProvider) {
      case "anthropic":
        return this.anthropicProvider;
      case "chatgpt":
        return this.chatgptProvider;
      default:
        return null;
    }
  }

  public isEnabled(): boolean {
    return this.getProvider() !== null;
  }

  public isPopoverEnabled(): boolean {
    return this.isEnabled() && this.host.settings.aiShowInPopover;
  }

  public isFileAllowed(file: TFile | null | undefined): boolean {
    return !isDocumentIgnored(this.host.app, file);
  }

  public isViewAllowed(view: EditorView): boolean {
    return this.isFileAllowed(getEditorFile(view));
  }

  public clearCache(): void {
    this.cache.clear();
    this.chatgptProvider?.clearModelCache();
  }

  /**
   * Alternatives for one passage. Results are cached by provider, model,
   * count, message and passage; failures are not cached, so a retry asks
   * again.
   */
  public getAlternatives(text: string, issue?: string): Promise<string[]> {
    const provider = this.getProvider();
    if (!provider) {
      return Promise.reject(
        new AiError("AI alternatives are turned off in the settings.")
      );
    }

    const settings = this.host.settings;
    const request: AlternativesRequest = {
      text,
      issue,
      count: Math.min(3, Math.max(1, settings.aiAlternativesCount))
    };
    const model =
      provider.id === "anthropic"
        ? settings.aiAnthropicModel
        : settings.aiChatgptModel;
    const key = JSON.stringify([
      provider.id,
      model,
      request.count,
      issue ?? "",
      text
    ]);

    const cached = this.cache.get(key);
    if (cached) return cached;

    const promise = provider.generate(request);
    this.cache.set(key, promise);
    promise.catch(() => {
      if (this.cache.get(key) === promise) {
        this.cache.delete(key);
      }
    });
    return promise;
  }
}

function getEditorFile(view: EditorView): TFile | null {
  return view.state.field(editorInfoField, false)?.file ?? null;
}
