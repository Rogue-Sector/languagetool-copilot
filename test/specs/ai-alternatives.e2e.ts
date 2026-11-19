import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import {
  PLUGIN_ID,
  closeSettings,
  hasSecretStorage,
  initWindows,
  openPluginSettings,
  settingItem,
  useEnvLanguageToolServer
} from "../helpers";

// Every AI request in these tests goes to a mock transport installed on the
// plugin. Nothing reaches Anthropic or OpenAI, and all keys and tokens below
// are made-up placeholders.

const ACTIVE = ".workspace-leaf.mod-active";
const FAKE_ANTHROPIC_KEY = "test-placeholder-anthropic-key";
const KEY_SECRET = "languagetool-copilot-test-anthropic-key";
const SESSION_SECRET = "languagetool-copilot-chatgpt-session";

interface RecordedCall {
  url: string;
  body: string;
}

type MockMode = "anthropic" | "chatgpt" | "chatgpt-dead-refresh";

async function installMock(mode: MockMode): Promise<void> {
  await browser.executeObsidian(({ app }, m: string) => {
    const w = window as any;
    w.__ltAiCalls = [];
    let responsesCalls = 0;
    const plugin = (app as any).plugins.plugins["languagetool-copilot"];

    // Deterministic rewrites of whatever passage the prompt carried
    const rewrite = (prompt: string): string[] => {
      const passage = /<<<\n([\s\S]*)\n>>>/.exec(prompt)?.[1] ?? "";
      return [
        passage.replace("sentense", "sentence").replace("nice", "pleasant"),
        `Mock rewrite: ${passage}`
      ];
    };

    plugin.alternatives.http = async (req: any) => {
      const body = typeof req.body === "string" ? req.body : "";
      w.__ltAiCalls.push({ url: req.url, body });
      const json = (status: number, value: unknown) => ({
        status,
        text: JSON.stringify(value),
        headers: {}
      });

      if (m === "anthropic") {
        const prompt = JSON.parse(body).messages[0].content;
        return json(200, {
          content: [
            {
              type: "text",
              text: JSON.stringify({ alternatives: rewrite(prompt) })
            }
          ],
          stop_reason: "end_turn"
        });
      }

      if (req.url.endsWith("/oauth/token")) {
        if (m === "chatgpt-dead-refresh") {
          return json(400, { error: "invalid_grant" });
        }
        return json(200, {
          access_token: "fake-access-2",
          refresh_token: "fake-refresh-2",
          expires_in: 3600,
          token_type: "Bearer"
        });
      }
      if (req.url.endsWith("/v1/models")) {
        return json(200, {
          models: [
            { slug: "hidden-model", visibility: "hide" },
            { slug: "listed-model", visibility: "list" }
          ]
        });
      }
      if (req.url.endsWith("/v1/responses")) {
        responsesCalls++;
        // The first inference call is rejected, as after a server-side
        // token expiry, so the provider has to refresh and retry once
        if (responsesCalls === 1) {
          return json(401, { error: { code: "invalid_token" } });
        }
        const prompt = JSON.parse(body).input[0].content;
        const reply = JSON.stringify({ alternatives: rewrite(prompt) });
        const half = Math.floor(reply.length / 2);
        const events = [
          { type: "response.created" },
          { type: "response.output_text.delta", delta: reply.slice(0, half) },
          { type: "response.output_text.delta", delta: reply.slice(half) },
          { type: "response.completed" }
        ];
        return {
          status: 200,
          text: events
            .map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
            .join(""),
          headers: {}
        };
      }
      return json(404, {});
    };
  }, mode);
}

async function getCalls(): Promise<RecordedCall[]> {
  return browser.execute(
    () => ((window as any).__ltAiCalls ?? []) as RecordedCall[]
  );
}

async function configure(settings: Record<string, unknown>): Promise<void> {
  await browser.executeObsidian(({ app }, values: Record<string, unknown>) => {
    const plugin = (app as any).plugins.plugins["languagetool-copilot"];
    Object.assign(plugin.settings, values);
    plugin.alternatives.clearCache();
  }, settings);
}

async function getEditorText(): Promise<string> {
  return browser.executeObsidian(({ app, obsidian }) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    return view ? view.editor.getValue() : "";
  });
}

async function openPopoverOn(word: string): Promise<void> {
  await browser.executeObsidianCommand(`${PLUGIN_ID}:ltcheck-text`);
  const underline = browser.$(
    `//div[contains(@class, "mod-active")]//span[contains(@class, "lt-underline") and normalize-space()="${word}"]`
  );
  await underline.waitForExist();
  await underline.click();
  await expect(browser.$(`${ACTIVE} .lt-predictions-container`)).toExist();
}

async function selectText(text: string): Promise<void> {
  await browser.executeObsidian(({ app, obsidian }, target: string) => {
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view) throw new Error("no active markdown view");
    const offset = view.editor.getValue().indexOf(target);
    if (offset < 0) throw new Error(`"${target}" not found in note`);
    view.editor.setSelection(
      view.editor.offsetToPos(offset),
      view.editor.offsetToPos(offset + target.length)
    );
  }, text);
}

// Save the settings and return data.json exactly as written to disk.
// obsidianPage.resetVault() can remove the .obsidian/plugins folder of the
// test vault, which makes saveData fail silently, so recreate it first.
async function savedSettingsFile(): Promise<string> {
  const raw = await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as any).plugins.plugins["languagetool-copilot"];
    const dir: string = plugin.manifest.dir;
    if (!(await app.vault.adapter.exists(dir))) {
      await app.vault.adapter.mkdir(dir);
    }
    await plugin.saveSettings();
    return app.vault.adapter.read(`${dir}/data.json`);
  });
  // Guard against a vacuous pass: the file must hold the AI settings
  expect(raw).toContain("aiProvider");
  return raw;
}

describe("AI alternatives", function() {
  // LanguageTool is real (CI runs its own server); one retry rides out a
  // throttled public API
  this.retries(1);

  before(async function() {
    await initWindows();
    if (!(await hasSecretStorage())) {
      // Keys and tokens require SecretStorage (Obsidian 1.11.4+)
      this.skip();
    }
    await useEnvLanguageToolServer();
    await browser.executeObsidian(({ app }, args: string[]) => {
      (app as any).secretStorage.setSecret(args[0], args[1]);
    }, [KEY_SECRET, FAKE_ANTHROPIC_KEY]);
  });

  beforeEach(async function() {
    // Also returns to the main window if a settings test left a popout open
    await closeSettings();
    await browser.executeObsidian(({ app }) => {
      app.workspace.detachLeavesOfType("markdown");
    });
    await obsidianPage.resetVault();
    await configure({
      aiProvider: "anthropic",
      aiShowInPopover: true,
      aiAlternativesCount: 2,
      aiAnthropicModel: "",
      aiChatgptModel: "",
      aiAnthropicKeySecretName: KEY_SECRET
    });
    await installMock("anthropic");
  });

  after(async function() {
    await closeSettings();
    await configure({ aiProvider: "off" });
  });

  it("shows alternatives in the popover, sending only the sentence", async function() {
    await obsidianPage.openFile("AiSentence.md");
    await openPopoverOn("sentense");

    const rows = browser.$$(`${ACTIVE} .lt-alternative .lt-alternative-text`);
    await browser.waitUntil(async () => (await rows.length) === 2);
    expect(await rows.map(r => r.getText())).toEqual([
      "This is a sentence with a mistake in it.",
      "Mock rewrite: This is a sentense with a mistake in it."
    ]);

    const calls = await getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const sent = JSON.parse(calls[0].body);
    expect(sent.model).toBe("claude-haiku-5-5");
    const prompt: string = sent.messages[0].content;
    expect(prompt).toContain("This is a sentense with a mistake in it.");
    // LanguageTool's message travels along as context
    expect(prompt).toContain("Issue reported by the grammar checker:");
    // The neighbouring sentences never leave the note
    expect(calls[0].body).not.toContain("The weather was nice");
    expect(calls[0].body).not.toContain("We went home");
  });

  it("replaces exactly the sentence when an alternative is inserted", async function() {
    await obsidianPage.openFile("AiSentence.md");
    await openPopoverOn("sentense");

    const insert = browser.$(`${ACTIVE} .lt-alternative .lt-alternative-insert`);
    await insert.waitForExist();
    await insert.click();

    expect(await getEditorText()).toBe(
      "The weather was nice. This is a sentence with a mistake in it. We went home.\n"
    );
  });

  it("reuses cached alternatives when the popover opens again", async function() {
    await obsidianPage.openFile("AiSentence.md");
    await openPopoverOn("sentense");
    await browser.$(`${ACTIVE} .lt-alternative`).waitForExist();

    await browser.keys("Escape");
    await expect(browser.$(`${ACTIVE} .lt-predictions-container`)).not.toExist();
    await browser.executeObsidian(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      view!.editor.setCursor({ line: 0, ch: 0 });
    });
    await browser.$(`${ACTIVE} .lt-underline`).click();
    await browser.$(`${ACTIVE} .lt-alternative`).waitForExist();

    expect(await getCalls()).toHaveLength(1);
  });

  it("suggests alternatives for a selection", async function() {
    await obsidianPage.openFile("AiSentence.md");
    await selectText("The weather was nice.");
    await browser.executeObsidianCommand(`${PLUGIN_ID}:ltsuggest-alternatives`);

    const modal = browser.$(".modal.lt-alternatives-modal, .lt-alternatives-modal");
    await expect(modal).toExist();
    const insert = browser.$(".lt-alternatives-modal .lt-alternative-insert");
    await insert.waitForExist();
    await insert.click();

    expect(await getEditorText()).toBe(
      "The weather was pleasant. This is a sentense with a mistake in it. We went home.\n"
    );
    const calls = await getCalls();
    expect(calls).toHaveLength(1);
    const prompt: string = JSON.parse(calls[0].body).messages[0].content;
    expect(prompt).toContain("The weather was nice.");
    expect(prompt).not.toContain("Issue reported by the grammar checker");
    expect(calls[0].body).not.toContain("sentense");
  });

  it("sends nothing when the provider is off", async function() {
    await configure({ aiProvider: "off" });
    await obsidianPage.openFile("AiSentence.md");
    await openPopoverOn("sentense");

    // Give a request time to happen if it were going to
    await browser.pause(1000);
    await expect(browser.$(`${ACTIVE} .lt-alternatives`)).not.toExist();

    await selectText("The weather was nice.");
    await browser.executeObsidianCommand(`${PLUGIN_ID}:ltsuggest-alternatives`);
    await browser.pause(500);
    await expect(browser.$(".lt-alternatives-modal")).not.toExist();

    expect(await getCalls()).toHaveLength(0);
  });

  it("never sends text from a note tagged lt-ignore", async function() {
    await obsidianPage.openFile("AiIgnored.md");
    await selectText("The weather was nice.");
    await browser.executeObsidianCommand(`${PLUGIN_ID}:ltsuggest-alternatives`);

    await expect(browser.$(".notice*=tagged lt-ignore")).toExist();
    await expect(browser.$(".lt-alternatives-modal")).not.toExist();
    expect(await getCalls()).toHaveLength(0);
  });

  it("keeps the Anthropic key out of data.json", async function() {
    const data = await savedSettingsFile();
    expect(data).toContain(KEY_SECRET);
    expect(data).not.toContain(FAKE_ANTHROPIC_KEY);
  });

  it("states in the settings where text is sent", async function() {
    await openPluginSettings();
    const provider = () => settingItem("AI provider");
    const select = () => provider().$("select:not(.is-measuring)");

    await expect(provider()).toHaveText(
      expect.stringContaining("Anthropic (api.anthropic.com)")
    );
    await expect(settingItem("Anthropic API key")).toExist();

    await select().selectByAttribute("value", "chatgpt");
    await expect(provider()).toHaveText(
      expect.stringContaining("OpenAI (api.openai.com)")
    );
    await expect(
      settingItem("ChatGPT account").$("button=Continue with ChatGPT")
    ).toExist();

    await select().selectByAttribute("value", "off");
    await expect(provider()).toHaveText(
      expect.stringContaining("no text is sent")
    );
    await expect(settingItem("AI model")).not.toBeDisplayed();
    await closeSettings();
  });

  describe("with Sign in with ChatGPT", function() {
    beforeEach(async function() {
      // An expired session, as if the access token's hour had passed
      await browser.executeObsidian(({ app }, id: string) => {
        (app as any).secretStorage.setSecret(
          id,
          JSON.stringify({
            clientId: "oaiapp_test",
            subject: "user-test",
            accessToken: "fake-access-1",
            refreshToken: "fake-refresh-1",
            idToken: "fake.id.token",
            expiresAt: Date.now() - 1000,
            scopes: [
              "openid",
              "offline_access",
              "resource.invoke",
              "chatgpt.tokens.use.direct"
            ],
            savedAt: Date.now()
          })
        );
      }, SESSION_SECRET);
      await configure({ aiProvider: "chatgpt" });
    });

    afterEach(async function() {
      await browser.executeObsidian(({ app }, id: string) => {
        (app as any).secretStorage.setSecret(id, "");
      }, SESSION_SECRET);
    });

    it("refreshes, retries once after a 401 and reads the stream", async function() {
      await installMock("chatgpt");
      await obsidianPage.openFile("AiSentence.md");
      await openPopoverOn("sentense");

      const rows = browser.$$(`${ACTIVE} .lt-alternative .lt-alternative-text`);
      await browser.waitUntil(async () => (await rows.length) === 2);
      await expect(browser.$(`${ACTIVE} .lt-alternatives-plan`)).toExist();

      const calls = await getCalls();
      const urls = calls.map(c => c.url);
      expect(urls).toEqual([
        // Expired: refresh before the first request
        "https://auth.openai.com/api/accounts/oauth/token",
        "https://api.openai.com/v1/models",
        "https://api.openai.com/v1/responses",
        // 401: refresh once and retry
        "https://auth.openai.com/api/accounts/oauth/token",
        "https://api.openai.com/v1/responses"
      ]);
      const refresh = new URLSearchParams(calls[0].body);
      expect(refresh.get("grant_type")).toBe("refresh_token");
      expect(refresh.get("client_id")).toBe("oaiapp_test");
      expect(refresh.get("refresh_token")).toBe("fake-refresh-1");
      // The second refresh uses the rotated refresh token
      expect(new URLSearchParams(calls[3].body).get("refresh_token")).toBe(
        "fake-refresh-2"
      );

      const inference = JSON.parse(calls[4].body);
      expect(inference.model).toBe("listed-model");
      expect(inference.store).toBe(false);
      expect(inference.stream).toBe(true);
      expect(calls[4].body).not.toContain("The weather was nice");

      // Rotated tokens live in SecretStorage and nowhere in data.json
      const session = await browser.executeObsidian(
        ({ app }, id: string) => (app as any).secretStorage.getSecret(id),
        SESSION_SECRET
      );
      expect(session).toContain("fake-refresh-2");
      const data = await savedSettingsFile();
      for (const token of [
        "fake-access-1",
        "fake-access-2",
        "fake-refresh-1",
        "fake-refresh-2",
        "oaiapp_test"
      ]) {
        expect(data).not.toContain(token);
      }
    });

    it("asks to sign in again when the refresh token is dead", async function() {
      await installMock("chatgpt-dead-refresh");
      await obsidianPage.openFile("AiSentence.md");
      await openPopoverOn("sentense");

      const error = browser.$(`${ACTIVE} .lt-alternatives-error`);
      await error.waitForExist();
      expect(await error.getText()).toContain("Sign in again");

      const session = await browser.executeObsidian(
        ({ app }, id: string) => (app as any).secretStorage.getSecret(id),
        SESSION_SECRET
      );
      expect(session ?? "").toBe("");
    });
  });
});
