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

export interface SideViewPatch {
  parentStatus?: ParentStatus | undefined;
  modelLabel?: string;
  thinkingLevel?: string;
  error?: string | undefined;
  notice?: string | undefined;
  closing?: boolean;
}

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
  private viewRev = 0;
  private editorRev = 0;
  private frameCache?: { key: string; lines: string[] };
  private editorCache?: { key: string; lines: string[] };

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
      this.editorRev++;
      this.editorCache = undefined;
      options.onSubmit(prompt);
      this.bump();
    };
    this.unsubscribeTranscript = this.transcript.onChange(() => this.bump());
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    if (this._focused === value) return;
    this._focused = value;
    this.editor.focused = value;
    this.editorRev++;
    this.editorCache = undefined;
    this.bump();
  }

  /** Batch presentation updates; keys present with undefined clear the field. */
  patch(update: SideViewPatch): void {
    let changed = false;
    if ("parentStatus" in update && update.parentStatus !== this.parentStatus) {
      this.parentStatus = update.parentStatus;
      changed = true;
    }
    if ("modelLabel" in update && update.modelLabel !== undefined && update.modelLabel !== this.modelLabel) {
      this.modelLabel = update.modelLabel;
      changed = true;
    }
    if (
      "thinkingLevel" in update &&
      update.thinkingLevel !== undefined &&
      update.thinkingLevel !== this.thinkingLevel
    ) {
      this.thinkingLevel = update.thinkingLevel;
      changed = true;
    }
    if ("error" in update && update.error !== this.error) {
      this.error = update.error;
      changed = true;
    }
    if ("notice" in update && update.notice !== this.notice) {
      this.notice = update.notice;
      changed = true;
    }
    if ("closing" in update && update.closing !== undefined && update.closing !== this.closing) {
      this.closing = update.closing;
      changed = true;
    }
    if (changed) this.bump();
  }

  setParentStatus(status: ParentStatus | undefined): void {
    this.patch({ parentStatus: status });
  }

  setModel(modelLabel: string): void {
    this.patch({ modelLabel });
  }

  setThinkingLevel(level: string): void {
    this.patch({ thinkingLevel: level });
  }

  setError(error: string | undefined): void {
    this.patch({ error });
  }

  setNotice(notice: string | undefined): void {
    this.patch({ notice });
  }

  setClosing(closing: boolean): void {
    this.patch({ closing });
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
        this.editorRev++;
        this.editorCache = undefined;
        this.bump();
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
    let scrolled = false;
    if (matchesKey(data, "pageUp")) {
      if (maxScroll > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - this.lastViewportHeight);
        this.autoScroll = false;
        scrolled = true;
      }
    } else if (matchesKey(data, "pageDown")) {
      if (maxScroll > 0) {
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + this.lastViewportHeight);
        this.autoScroll = this.scrollOffset >= maxScroll;
        scrolled = true;
      }
    } else if (matchesKey(data, "alt+up")) {
      if (maxScroll > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        this.autoScroll = false;
        scrolled = true;
      }
    } else if (matchesKey(data, "alt+down")) {
      if (maxScroll > 0) {
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
        this.autoScroll = this.scrollOffset >= maxScroll;
        scrolled = true;
      }
    } else if (matchesKey(data, "ctrl+home")) {
      if (maxScroll > 0) {
        this.scrollOffset = 0;
        this.autoScroll = false;
        scrolled = true;
      }
    } else if (matchesKey(data, "ctrl+end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
      scrolled = true;
    } else {
      this.editor.handleInput(data);
      this.editorRev++;
      this.editorCache = undefined;
      this.bump();
      return;
    }
    if (scrolled) this.bump();
  }

  render(width: number): string[] {
    if (width < 8) return [this.theme.fg("dim", "Side (resize terminal)")];
    const rows = this.tui.terminal.rows;
    // Auto-scroll reclamps scrollOffset during render; key only on manual offset.
    const scrollKey = this.autoScroll ? "a" : String(this.scrollOffset);
    const frameKey = `${width}|${rows}|${this.viewRev}|${scrollKey}`;
    if (this.frameCache?.key === frameKey) return this.frameCache.lines;

    const innerWidth = width - 4;
    const row = (content: string) => {
      const truncated = truncateToWidth(content, innerWidth, "...", true);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
      return `${this.theme.fg("border", "│")} ${truncated}${padding} ${this.theme.fg("border", "│")}`;
    };
    const horizontal = (left: string, middle: string, right: string) =>
      this.theme.fg("border", `${left}${middle.repeat(Math.max(0, width - 2))}${right}`);
    const divider = row(this.theme.fg("borderMuted", "─".repeat(innerWidth)));

    const editorKey = `${innerWidth}|${rows}|${this.editorRev}|${this._focused ? 1 : 0}`;
    let editorLines = this.editorCache?.key === editorKey ? this.editorCache.lines : undefined;
    if (!editorLines) {
      editorLines = this.editor.render(innerWidth);
      this.editorCache = { key: editorKey, lines: editorLines };
    }

    const maxRows = Math.max(8, Math.floor(rows * 0.85));
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

    this.frameCache = { key: frameKey, lines };
    return lines;
  }

  invalidate(): void {
    this.editor.invalidate();
    this.transcript.invalidate();
    this.editorCache = undefined;
    this.editorRev++;
    this.bump();
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribeTranscript();
  }

  private requestClose(): void {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.bump();
    this.onClose();
  }

  private bump(): void {
    if (this.closed) return;
    this.viewRev++;
    this.frameCache = undefined;
    this.tui.requestRender();
  }
}
