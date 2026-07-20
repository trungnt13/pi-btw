import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type Focusable,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SideTranscript } from "./transcript.js";

export type ParentStatus = "running" | "finished" | "failed" | "interrupted";

interface SideViewOptions {
  tui: TUI;
  theme: Theme;
  transcript: SideTranscript;
  modelLabel: string;
  thinkingLevel: string;
  parentStatus?: ParentStatus;
  isStreaming: () => boolean;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onClose: () => void;
}

function parentStatusLabel(status: ParentStatus | undefined): string | undefined {
  return status ? `main ${status}` : undefined;
}

export class SideView implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly transcript: SideTranscript;
  private readonly isStreaming: () => boolean;
  private readonly onAbort: () => void;
  private readonly onClose: () => void;
  private readonly editor: Editor;
  private readonly unsubscribeTranscript: () => void;
  private parentStatus?: ParentStatus;
  private modelLabel: string;
  private thinkingLevel: string;
  private scrollOffset = 0;
  private autoScroll = true;
  private lastViewportHeight = 8;
  private lastTotalLines = 1;
  private error?: string;
  private notice?: string;
  private closing = false;
  private closed = false;
  private _focused = false;

  constructor(options: SideViewOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.transcript = options.transcript;
    this.modelLabel = options.modelLabel;
    this.thinkingLevel = options.thinkingLevel;
    this.parentStatus = options.parentStatus;
    this.isStreaming = options.isStreaming;
    this.onAbort = options.onAbort;
    this.onClose = options.onClose;
    this.editor = new Editor(
      this.tui,
      {
        borderColor: (text) => this.theme.fg("borderMuted", text),
        selectList: getSelectListTheme(),
      },
      { paddingX: 0 },
    );
    this.editor.onSubmit = (text) => {
      const prompt = text.trim();
      if (!prompt || this.closing) return;
      this.editor.setText("");
      this.error = undefined;
      this.notice = undefined;
      this.autoScroll = true;
      options.onSubmit(prompt);
      this.tui.requestRender();
    };
    this.unsubscribeTranscript = this.transcript.onChange(() => this.tui.requestRender());
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  setParentStatus(status: ParentStatus | undefined): void {
    this.parentStatus = status;
    this.tui.requestRender();
  }

  setModel(modelLabel: string): void {
    this.modelLabel = modelLabel;
    this.tui.requestRender();
  }

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
    this.tui.requestRender();
  }

  setError(error: string | undefined): void {
    this.error = error;
    this.tui.requestRender();
  }

  setNotice(notice: string | undefined): void {
    this.notice = notice;
    this.tui.requestRender();
  }

  setClosing(closing: boolean): void {
    this.closing = closing;
    this.tui.requestRender();
  }

  markClosed(): void {
    this.closed = true;
  }

  handleInput(data: string): void {
    if (this.closing) return;
    const editorEmpty = this.editor.getText().length === 0;
    if (matchesKey(data, "ctrl+c")) {
      if (editorEmpty) this.requestClose();
      else {
        this.editor.setText("");
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "ctrl+d") && editorEmpty) {
      this.requestClose();
      return;
    }
    if (matchesKey(data, "escape") && this.isStreaming()) {
      this.onAbort();
      return;
    }

    const maxScroll = Math.max(0, this.lastTotalLines - this.lastViewportHeight);
    if (matchesKey(data, "pageUp")) {
      if (maxScroll > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - this.lastViewportHeight);
        this.autoScroll = false;
      }
    } else if (matchesKey(data, "pageDown")) {
      if (maxScroll > 0) {
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + this.lastViewportHeight);
        this.autoScroll = this.scrollOffset >= maxScroll;
      }
    } else if (matchesKey(data, "alt+up")) {
      if (maxScroll > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        this.autoScroll = false;
      }
    } else if (matchesKey(data, "alt+down")) {
      if (maxScroll > 0) {
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
        this.autoScroll = this.scrollOffset >= maxScroll;
      }
    } else if (matchesKey(data, "ctrl+home")) {
      if (maxScroll > 0) {
        this.scrollOffset = 0;
        this.autoScroll = false;
      }
    } else if (matchesKey(data, "ctrl+end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    } else {
      this.editor.handleInput(data);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 8) return [this.theme.fg("dim", "Side (resize terminal)")];
    const innerWidth = width - 4;
    const row = (content: string) => {
      const truncated = truncateToWidth(content, innerWidth, "...", true);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
      return `${this.theme.fg("border", "│")} ${truncated}${padding} ${this.theme.fg("border", "│")}`;
    };
    const horizontal = (left: string, middle: string, right: string) =>
      this.theme.fg("border", `${left}${middle.repeat(Math.max(0, width - 2))}${right}`);
    const divider = row(this.theme.fg("borderMuted", "─".repeat(innerWidth)));

    // Keep Editor's contiguous cursor-bearing window intact; do not re-clip it.
    const editorLines = this.editor.render(innerWidth);
    const maxRows = Math.max(8, Math.floor(this.tui.terminal.rows * 0.85));
    const infoLines = Number(this.error !== undefined) + Number(this.notice !== undefined);
    const viewportHeight = Math.max(1, maxRows - 6 - editorLines.length - infoLines);
    this.lastViewportHeight = viewportHeight;

    const content = this.transcript.renderSlice(
      this.theme,
      innerWidth,
      this.autoScroll ? Number.MAX_SAFE_INTEGER : this.scrollOffset,
      viewportHeight,
    );
    this.lastTotalLines = content.totalLines;
    this.scrollOffset = content.start;

    const statusParts = ["from main thread", parentStatusLabel(this.parentStatus)].filter(
      (part): part is string => part !== undefined,
    );
    const header =
      this.theme.fg("accent", this.theme.bold("Side")) +
      this.theme.fg("muted", ` · ${statusParts.join(" · ")} · ${this.modelLabel} · ${this.thinkingLevel}`);

    const lines = [horizontal("╭", "─", "╮"), row(header), divider];
    for (let index = 0; index < viewportHeight; index++) lines.push(row(content.lines[index] ?? ""));
    lines.push(divider);
    for (const editorLine of editorLines) lines.push(row(editorLine));
    if (this.notice) lines.push(row(this.theme.fg("success", this.notice)));
    if (this.error) lines.push(row(this.theme.fg("error", `Error: ${this.error}`)));

    const scroll =
      content.totalLines > viewportHeight
        ? `${this.scrollOffset + 1}-${Math.min(content.totalLines, this.scrollOffset + viewportHeight)}/${content.totalLines}`
        : `${content.totalLines} lines`;
    const action = this.closing ? "closing..." : "PgUp/PgDn scroll · Esc abort · empty Ctrl+C/Ctrl+D return";
    lines.push(row(this.theme.fg("dim", `${scroll} · ${action}`)));
    lines.push(horizontal("╰", "─", "╯"));
    return lines;
  }

  invalidate(): void {
    this.editor.invalidate();
    this.transcript.invalidate();
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribeTranscript();
  }

  private requestClose(): void {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.tui.requestRender();
    this.onClose();
  }
}
