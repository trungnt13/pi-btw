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
  private lastInnerWidth = 80;
  private lastViewportHeight = 8;
  private error?: string;
  private notice?: string;
  private renderTimer?: ReturnType<typeof setTimeout>;
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
      this.scheduleRender(true);
    };
    this.unsubscribeTranscript = this.transcript.onChange(() => this.scheduleRender());
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
    this.scheduleRender();
  }

  setModel(modelLabel: string): void {
    this.modelLabel = modelLabel;
    this.scheduleRender(true);
  }

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
    this.scheduleRender(true);
  }

  setError(error: string | undefined): void {
    this.error = error;
    this.scheduleRender(true);
  }

  setNotice(notice: string | undefined): void {
    this.notice = notice;
    this.scheduleRender(true);
  }

  setClosing(closing: boolean): void {
    this.closing = closing;
    this.scheduleRender(true);
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
        this.scheduleRender(true);
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

    const totalLines = this.transcript.renderSlice(this.theme, this.lastInnerWidth, 0, 0).totalLines;
    const maxScroll = Math.max(0, totalLines - this.lastViewportHeight);
    if (matchesKey(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.lastViewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + this.lastViewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "alt+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = false;
    } else if (matchesKey(data, "alt+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "ctrl+home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "ctrl+end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    } else {
      this.editor.handleInput(data);
    }
    this.scheduleRender(true);
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const innerWidth = width - 4;
    this.lastInnerWidth = innerWidth;
    const row = (content: string) => {
      const truncated = truncateToWidth(content, innerWidth, "...", true);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
      return `${this.theme.fg("border", "│")} ${truncated}${padding} ${this.theme.fg("border", "│")}`;
    };
    const horizontal = (left: string, middle: string, right: string) =>
      this.theme.fg("border", `${left}${middle.repeat(Math.max(0, width - 2))}${right}`);
    const divider = row(this.theme.fg("borderMuted", "─".repeat(innerWidth)));

    const fullEditorLines = this.editor.render(innerWidth);
    const maxRows = Math.max(8, Math.floor(this.tui.terminal.rows * 0.85));
    const maxEditorLines = Math.max(3, Math.floor(maxRows * 0.35));
    const editorLines =
      fullEditorLines.length <= maxEditorLines
        ? fullEditorLines
        : [fullEditorLines[0] ?? "", ...fullEditorLines.slice(-(maxEditorLines - 1))];
    const infoLines = Number(this.error !== undefined) + Number(this.notice !== undefined);
    const viewportHeight = Math.max(1, maxRows - 6 - editorLines.length - infoLines);
    this.lastViewportHeight = viewportHeight;

    const content = this.transcript.renderSlice(
      this.theme,
      innerWidth,
      this.autoScroll ? Number.MAX_SAFE_INTEGER : this.scrollOffset,
      viewportHeight,
    );
    const totalLines = content.totalLines;
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
      totalLines > viewportHeight
        ? `${this.scrollOffset + 1}-${Math.min(totalLines, this.scrollOffset + viewportHeight)}/${totalLines}`
        : `${totalLines} lines`;
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
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.unsubscribeTranscript();
  }

  private requestClose(): void {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.scheduleRender(true);
    this.onClose();
  }

  private scheduleRender(immediate = false): void {
    if (this.closed) return;
    if (immediate) {
      if (this.renderTimer) clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.tui.requestRender();
      return;
    }
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 16);
    this.renderTimer.unref();
  }
}
