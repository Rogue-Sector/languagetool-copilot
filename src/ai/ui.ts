import { App, Modal, Notice, setIcon } from "obsidian";
import { EditorView } from "@codemirror/view";
import { clearUnderlinesInRange } from "../cm6/underlineStateField";
import { ManageUsageUrl } from "./chatgpt/constants";
import { SentenceRange } from "./sentence";
import { AlternativesService } from "./service";
import { AiError } from "./types";

/**
 * Replace the passage with the chosen alternative, but only if the passage
 * is still exactly where and what it was when the alternatives were asked
 * for. Returns whether the editor changed.
 */
export function replacePassage(
  view: EditorView,
  range: SentenceRange,
  replacement: string
): boolean {
  if (
    range.to > view.state.doc.length ||
    view.state.sliceDoc(range.from, range.to) !== range.text
  ) {
    new Notice(
      "The text changed since the alternatives were written, so nothing was replaced.",
      5000
    );
    return false;
  }
  view.dispatch({
    changes: [{ from: range.from, to: range.to, insert: replacement }],
    effects: [clearUnderlinesInRange.of({ from: range.from, to: range.to })],
    userEvent: "input.replace"
  });
  return true;
}

function errorMessage(e: unknown): string {
  if (e instanceof AiError) {
    return e.requestId ? `${e.message} (request ${e.requestId})` : e.message;
  }
  console.error(e);
  return "Something went wrong while writing alternatives.";
}

/**
 * The alternatives list shared by the popover and the selection modal:
 * a loading state, then one row per alternative with an insert button, or
 * an error with a retry button.
 */
export function renderAlternatives(
  container: HTMLElement,
  service: AlternativesService,
  options: {
    view: EditorView;
    range: SentenceRange;
    issue?: string;
    onInserted?: () => void;
  }
): void {
  const { view, range, issue } = options;

  container.addClass("lt-alternatives");
  container.createDiv({ cls: "lt-alternatives-header" }, header => {
    header.createSpan({ cls: "lt-alternatives-title", text: "AI alternatives" });
    if (service.getProvider()?.id === "chatgpt") {
      header.createSpan({ cls: "lt-alternatives-plan" }, span => {
        span.createSpan({ text: "Using ChatGPT plan · " });
        span.createEl("a", { text: "Manage usage", href: ManageUsageUrl });
      });
    }
  });
  const body = container.createDiv({ cls: "lt-alternatives-body" });

  const load = () => {
    body.empty();
    body.createDiv({ cls: "lt-alternatives-loading" }, loading => {
      setIcon(loading.createSpan({ cls: "lt-loading" }), "loader-2");
      loading.createSpan({ text: "Writing alternatives…" });
    });

    service.getAlternatives(range.text, issue).then(
      alternatives => {
        body.empty();
        for (const alternative of alternatives) {
          body.createDiv({ cls: "lt-alternative" }, row => {
            row.createDiv({ cls: "lt-alternative-text", text: alternative });
            row.createEl(
              "button",
              {
                cls: "lt-alternative-insert",
                text: "Insert",
                attr: { "aria-label": `Insert: ${alternative}` }
              },
              button => {
                button.onclick = () => {
                  if (replacePassage(view, range, alternative)) {
                    options.onInserted?.();
                  }
                };
              }
            );
          });
        }
      },
      (e: unknown) => {
        body.empty();
        body.createDiv({
          cls: "lt-alternatives-error",
          text: errorMessage(e)
        });
        body.createEl(
          "button",
          { cls: "lt-alternatives-retry", text: "Try again" },
          button => {
            button.onclick = load;
          }
        );
      }
    );
  };
  load();
}

/** Alternatives for a selection, shown in a modal so it works on mobile. */
export class AlternativesModal extends Modal {
  public constructor(
    app: App,
    private readonly service: AlternativesService,
    private readonly view: EditorView,
    private readonly range: SentenceRange
  ) {
    super(app);
  }

  public onOpen(): void {
    this.titleEl.setText("Alternatives for the selection");
    this.contentEl.addClass("lt-alternatives-modal");
    this.contentEl.createDiv({
      cls: "lt-alternatives-original",
      text: this.range.text
    });
    renderAlternatives(this.contentEl.createDiv(), this.service, {
      view: this.view,
      range: this.range,
      onInserted: () => this.close()
    });
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Shown once, after the first sign-in with plan usage, as OpenAI's UI
 * guidelines ask.
 */
export class ChatgptWelcomeModal extends Modal {
  public onOpen(): void {
    this.titleEl.setText("You're using your ChatGPT plan");
    this.contentEl.createEl("p", {
      text:
        "AI alternatives in LanguageTool Copilot now use your ChatGPT plan, and count towards its usage limits. This plugin has no plans or charges of its own."
    });
    this.contentEl.createEl("p", {}, p => {
      p.appendText("You can see and manage usage in ");
      p.createEl("a", { text: "ChatGPT settings", href: ManageUsageUrl });
      p.appendText(".");
    });
    this.contentEl.createDiv({ cls: "modal-button-container" }, buttons => {
      buttons.createEl("button", { cls: "mod-cta", text: "Got it" }).onclick = () =>
        this.close();
    });
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}
