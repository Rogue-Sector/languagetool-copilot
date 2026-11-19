import { App, Notice, Platform, SecretComponent, requireApiVersion } from "obsidian";
import LanguageToolPlugin from "..";
import { RenderedSettingDefinition, SettingsSection } from "../SettingsTab";
import { DefaultAnthropicModel } from "./anthropic";
import { ManageUsageUrl } from "./chatgpt/constants";
import { ChatgptWelcomeModal } from "./ui";
import { AiError, AiProviderId } from "./types";

const ProviderLabels: Record<AiProviderId, string> = {
  off: "Off",
  anthropic: "Anthropic API key",
  chatgpt: "Sign in with ChatGPT"
};

function describeDestination(provider: AiProviderId): string {
  switch (provider) {
    case "anthropic":
      return "Text is sent to Anthropic (api.anthropic.com) and billed to your Anthropic API key.";
    case "chatgpt":
      return "Text is sent to OpenAI (api.openai.com) and counts towards your ChatGPT plan's usage.";
    default:
      return "Off: no text is sent anywhere.";
  }
}

function addLink(el: HTMLElement, text: string, href: string): void {
  el.createEl("a", { text, href }, a => {
    a.setAttr("target", "_blank");
  });
}

export function getAiSection(
  app: App,
  plugin: LanguageToolPlugin,
  rerender: () => void
): SettingsSection {
  const settings = plugin.settings;
  const service = plugin.alternatives;
  const secretsAvailable = plugin.isSecretStorageAvailable();
  const provider = settings.aiProvider;
  const items: RenderedSettingDefinition[] = [];

  items.push({
    name: "AI provider",
    desc: describeDestination(provider),
    render: setting => {
      setting.descEl.createEl("br");
      setting.descEl.appendText(
        "Only the sentence around a LanguageTool match (or your selection) and LanguageTool's message are sent, never the whole note. Notes tagged lt-ignore are never sent."
      );
      if (!secretsAvailable) {
        setting.descEl.createEl("br");
        setting.descEl.createSpan({
          cls: "lt-settings-error-text",
          text:
            "AI alternatives need Obsidian 1.11.4 or newer, which keeps keys and tokens in encrypted SecretStorage."
        });
      }
      setting.addDropdown(component => {
        component
          .addOptions(ProviderLabels)
          .setValue(provider)
          .setDisabled(!secretsAvailable)
          .onChange(async value => {
            settings.aiProvider = value as AiProviderId;
            service.clearCache();
            await plugin.saveSettings();
            rerender();
          });
      });
    }
  });

  if (provider === "anthropic" && secretsAvailable) {
    items.push({
      name: "Anthropic API key",
      desc:
        "Select or create a secret holding an API key from the Claude Console. Stored encrypted in Obsidian's SecretStorage on this device only.",
      render: setting => {
        setting.descEl.createEl("br");
        addLink(
          setting.descEl,
          "Create an API key in the Claude Console",
          "https://platform.claude.com/settings/keys"
        );
        if (requireApiVersion("1.11.4")) {
          setting.addComponent(el =>
            new SecretComponent(app, el)
              .setValue(settings.aiAnthropicKeySecretName ?? "")
              .onChange(async value => {
                settings.aiAnthropicKeySecretName = value || undefined;
                service.clearCache();
                await plugin.saveSettings();
              })
          );
        }
      }
    });
  }

  if (provider === "chatgpt" && secretsAvailable) {
    const auth = service.chatgptAuth;
    const status = auth?.getStatus();
    items.push({
      name: "ChatGPT account",
      desc: !Platform.isDesktopApp
        ? "Signing in with ChatGPT needs the desktop app, because it waits for the browser on this computer. Use an Anthropic API key on mobile."
        : status?.signedIn
        ? `Signed in${status.email ? ` as ${status.email}` : ""}.${
            status.planEnabled
              ? ""
              : " Plan usage was not granted, so alternatives will not work until you sign in again and allow it."
          }`
        : "Not signed in. Alternatives use your ChatGPT Plus or Pro plan.",
      render: setting => {
        if (status?.signedIn) {
          setting.descEl.createEl("br");
          setting.descEl.appendText("Using ChatGPT plan · ");
          addLink(setting.descEl, "Manage usage", ManageUsageUrl);
        }
        if (!auth || !Platform.isDesktopApp) {
          return;
        }
        if (auth.isSigningIn()) {
          setting.addButton(button =>
            button.setButtonText("Cancel sign-in").onClick(() => {
              auth.cancelSignIn();
            })
          );
        } else if (status?.signedIn) {
          setting.addButton(button =>
            button.setButtonText("Sign out").onClick(async () => {
              button.setDisabled(true);
              const revoked = await auth.signOut();
              service.clearCache();
              new Notice(
                revoked
                  ? "Signed out of ChatGPT."
                  : "Signed out on this device, but OpenAI did not confirm the sign-out. You can disconnect the app in ChatGPT settings.",
                revoked ? 4000 : 10000
              );
              rerender();
            })
          );
        } else {
          setting.addButton(button =>
            button
              .setButtonText("Continue with ChatGPT")
              .setCta()
              .onClick(async () => {
                new Notice("Finish signing in in your browser.", 5000);
                const signIn = auth.signIn();
                // Show the cancel button while the browser is open
                rerender();
                try {
                  await signIn;
                  service.clearCache();
                  new Notice("Signed in with ChatGPT.", 4000);
                  if (!settings.aiChatgptWelcomeShown) {
                    settings.aiChatgptWelcomeShown = true;
                    await plugin.saveSettings();
                    new ChatgptWelcomeModal(app).open();
                  }
                } catch (e) {
                  if (!(e instanceof AiError)) console.error(e);
                  new Notice(
                    e instanceof AiError
                      ? e.message
                      : "Signing in with ChatGPT failed.",
                    8000
                  );
                }
                rerender();
              })
          );
        }
      }
    });
    items.push({
      name: "Forget this device",
      desc:
        "Sign out and also delete this device's ChatGPT app registration and host ID. Use this to switch to a different ChatGPT account.",
      render: setting => {
        setting.addButton(button =>
          button
            .setButtonText("Forget this device")
            .setDisabled(!auth || auth.isSigningIn())
            .onClick(async () => {
              if (!auth) return;
              button.setDisabled(true);
              const revoked = await auth.forgetDevice();
              service.clearCache();
              new Notice(
                revoked
                  ? "ChatGPT sign-in and registration removed from this device."
                  : "Removed from this device, but OpenAI did not confirm the sign-out. You can disconnect the app in ChatGPT settings.",
                revoked ? 4000 : 10000
              );
              rerender();
            })
        );
      }
    });
  }

  if (provider !== "off" && secretsAvailable) {
    const isAnthropic = provider === "anthropic";
    items.push({
      name: "AI model",
      desc: isAnthropic
        ? `Model ID to use. Leave empty for ${DefaultAnthropicModel}.`
        : "Model to use. Leave empty for the first model your ChatGPT account offers.",
      render: setting => {
        setting.addText(text =>
          text
            .setPlaceholder(
              isAnthropic ? DefaultAnthropicModel : "First available model"
            )
            .setValue(
              isAnthropic ? settings.aiAnthropicModel : settings.aiChatgptModel
            )
            .onChange(async value => {
              if (isAnthropic) {
                settings.aiAnthropicModel = value.trim();
              } else {
                settings.aiChatgptModel = value.trim();
              }
              await plugin.saveSettings();
            })
        );
      }
    });
    items.push({
      name: "Number of alternatives",
      desc: "How many rewrites to ask for each time.",
      render: setting => {
        setting.addDropdown(component =>
          component
            .addOptions({ "1": "1", "2": "2", "3": "3" })
            .setValue(String(settings.aiAlternativesCount))
            .onChange(async value => {
              settings.aiAlternativesCount = Number(value);
              await plugin.saveSettings();
            })
        );
      }
    });
    items.push({
      name: "Show alternatives in the popover",
      desc:
        "Ask for alternatives whenever you open a LanguageTool popover. When off, use the \"Suggest alternatives for selection\" command instead.",
      render: setting => {
        setting.addToggle(component =>
          component
            .setValue(settings.aiShowInPopover)
            .onChange(async value => {
              settings.aiShowInPopover = value;
              await plugin.saveSettings();
            })
        );
      }
    });
  }

  return { heading: "AI alternatives", items };
}
