import type { AgentSession, AgentSessionEvent, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type ItemKind = "user" | "assistant" | "tool" | "system";
type ToolState = "running" | "success" | "error";

/** Presentation cap for tool rows (raw mode). AgentSession still holds full results. */
const TOOL_RAW_CAP = 10_000;
const TOOL_NORMAL_CAP = 1_500;

interface RenderCache {
  width: number;
  version: number;
  raw: boolean;
  theme: Theme;
  lines: string[];
}

interface TranscriptItem {
  id: number;
  kind: ItemKind;
  label: string;
  text: string;
  detail?: string;
  toolState?: ToolState;
  copyable?: boolean;
  version: number;
  cache?: RenderCache;
}

export interface TranscriptSlice {
  lines: string[];
  totalLines: number;
  start: number;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function hasNonTextContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type !== "text")
  );
}

function boundToolDisplay(text: string): string {
  if (text.length <= TOOL_RAW_CAP) return text;
  return `${text.slice(0, TOOL_RAW_CAP - 3)}...`;
}

function previewArguments(value: unknown): string {
  const serialized = JSON.stringify(value) ?? "";
  return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
}

export class SideTranscript {
  private readonly items: TranscriptItem[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly tools = new Map<string, TranscriptItem>();
  private readonly unsubscribe: () => void;
  /** Cumulative line ends for the current layout key; rebuilt from dirtyFrom. */
  private ends: number[] = [];
  private dirtyFrom = 0;
  private layoutWidth = -1;
  private layoutRaw = false;
  private layoutTheme?: Theme;
  private nextId = 1;
  private currentAssistant?: TranscriptItem;
  private raw = false;

  constructor(session: AgentSession) {
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setRaw(raw: boolean): void {
    if (this.raw === raw) return;
    this.raw = raw;
    this.invalidate();
    this.notify();
  }

  isRaw(): boolean {
    return this.raw;
  }

  appendSystem(label: string, text: string): void {
    this.append({ kind: "system", label, text });
  }

  lastAssistantText(): string | undefined {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index];
      if (item.kind === "assistant" && item.copyable !== false && item.text.trim()) return item.text.trim();
    }
    return undefined;
  }

  renderSlice(theme: Theme, width: number, requestedStart: number, count: number): TranscriptSlice {
    if (this.items.length === 0) {
      const line = theme.fg("dim", "Ask a question without interrupting the main task.");
      return {
        lines: count > 0 ? [truncateToWidth(line, width)] : [],
        totalLines: 1,
        start: 0,
      };
    }

    this.ensureHeights(theme, width);
    const totalLines = this.ends[this.ends.length - 1] ?? 0;
    const start = Math.min(Math.max(0, requestedStart), Math.max(0, totalLines - count));
    const end = start + count;
    const first = this.firstItemAtOrAfter(start);
    const lines: string[] = [];
    for (let index = first; index < this.items.length; index++) {
      const itemStart = index === 0 ? 0 : (this.ends[index - 1] ?? 0);
      if (itemStart >= end) break;
      const itemLines = this.renderItem(this.items[index], index > 0, theme, width);
      const itemEnd = itemStart + itemLines.length;
      if (itemEnd > start) {
        lines.push(...itemLines.slice(Math.max(0, start - itemStart), Math.min(itemLines.length, end - itemStart)));
      }
    }
    return { lines, totalLines, start };
  }

  invalidate(): void {
    for (const item of this.items) item.cache = undefined;
    this.ends = [];
    this.dirtyFrom = 0;
    this.layoutWidth = -1;
    this.layoutTheme = undefined;
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.tools.clear();
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (event.type === "message_start") {
      if (event.message.role === "user") {
        this.append({ kind: "user", label: "You", text: contentText(event.message.content) });
      } else if (event.message.role === "assistant") {
        this.currentAssistant = this.append({ kind: "assistant", label: "Side", text: "", copyable: true });
      } else if (event.message.role === "custom" && event.message.display) {
        this.append({ kind: "system", label: event.message.customType, text: contentText(event.message.content) });
      }
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const item = this.currentAssistant ?? this.append({ kind: "assistant", label: "Side", text: "", copyable: true });
      this.currentAssistant = item;
      this.update(item, item.text + event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = contentText(event.message.content);
      const item = this.currentAssistant ?? this.append({ kind: "assistant", label: "Side", text, copyable: true });
      if (item.text !== text && (text || !event.message.errorMessage)) this.update(item, text);

      const stop = event.message.stopReason;
      if (stop === "length") {
        this.append({ kind: "system", label: "Incomplete", text: "Response stopped at maximum output tokens." });
      } else if (stop === "aborted") {
        this.append({ kind: "system", label: "Aborted", text: event.message.errorMessage || "Side turn aborted." });
      } else if (stop === "error" || event.message.errorMessage) {
        const errorText = event.message.errorMessage || "Side response failed.";
        if (item.text.trim()) this.append({ kind: "system", label: "Response error", text: errorText });
        else {
          item.copyable = false;
          this.update(item, errorText);
        }
      }
      this.currentAssistant = undefined;
      return;
    }

    if (event.type === "tool_execution_start") {
      const item = this.append({
        kind: "tool",
        label: event.toolName,
        text: "Running...",
        detail: previewArguments(event.args),
        toolState: "running",
      });
      this.tools.set(event.toolCallId, item);
      return;
    }

    if (event.type === "tool_execution_update") {
      const item = this.tools.get(event.toolCallId);
      const text = contentText(event.partialResult.content);
      if (item && text) this.update(item, boundToolDisplay(text));
      return;
    }

    if (event.type === "tool_execution_end") {
      const item = this.tools.get(event.toolCallId);
      if (!item) return;
      const text = contentText(event.result.content);
      const fallback = hasNonTextContent(event.result.content) ? "(non-text tool output omitted)" : "(no output)";
      item.toolState = event.isError ? "error" : "success";
      this.update(item, boundToolDisplay(text || fallback));
      this.tools.delete(event.toolCallId);
      return;
    }

    if (event.type === "compaction_end") {
      if (event.aborted) {
        this.append({ kind: "system", label: "Compaction aborted", text: event.errorMessage || event.reason });
      } else if (!event.result) {
        this.append({ kind: "system", label: "Compaction failed", text: event.errorMessage || event.reason });
      } else {
        this.append({ kind: "system", label: "Context compacted", text: event.reason });
      }
      return;
    }

    if (event.type === "auto_retry_start") {
      this.append({ kind: "system", label: `Retry ${event.attempt}/${event.maxAttempts}`, text: event.errorMessage });
      return;
    }

    if (event.type === "auto_retry_end" && !event.success) {
      this.append({
        kind: "system",
        label: "Retry failed",
        text: event.finalError || `Attempt ${event.attempt} failed`,
      });
    }
  }

  private append(input: Omit<TranscriptItem, "id" | "version">): TranscriptItem {
    const item: TranscriptItem = { ...input, id: this.nextId++, version: 1 };
    this.items.push(item);
    this.markDirty(this.items.length - 1);
    this.notify();
    return item;
  }

  private update(item: TranscriptItem, text: string): void {
    item.text = text;
    item.version++;
    item.cache = undefined;
    const index = this.indexOf(item);
    if (index >= 0) this.markDirty(index);
    this.notify();
  }

  private indexOf(item: TranscriptItem): number {
    for (let index = this.items.length - 1; index >= 0; index--) {
      if (this.items[index] === item) return index;
    }
    return -1;
  }

  private markDirty(index: number): void {
    this.dirtyFrom = Math.min(this.dirtyFrom, Math.max(0, index));
  }

  private ensureHeights(theme: Theme, width: number): void {
    if (this.layoutWidth !== width || this.layoutRaw !== this.raw || this.layoutTheme !== theme) {
      this.layoutWidth = width;
      this.layoutRaw = this.raw;
      this.layoutTheme = theme;
      this.dirtyFrom = 0;
      this.ends = [];
    }
    if (this.dirtyFrom >= this.items.length && this.ends.length === this.items.length) return;

    const from = Math.min(this.dirtyFrom, this.items.length);
    let offset = from === 0 ? 0 : (this.ends[from - 1] ?? 0);
    this.ends.length = this.items.length;
    for (let index = from; index < this.items.length; index++) {
      offset += this.renderItem(this.items[index], index > 0, theme, width).length;
      this.ends[index] = offset;
    }
    this.dirtyFrom = this.items.length;
  }

  /** First item whose cumulative end is > start (covers the start offset). */
  private firstItemAtOrAfter(start: number): number {
    let low = 0;
    let high = this.ends.length - 1;
    let answer = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if ((this.ends[mid] ?? 0) <= start) low = mid + 1;
      else {
        answer = mid;
        high = mid - 1;
      }
    }
    return answer;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private renderItem(item: TranscriptItem, separated: boolean, theme: Theme, width: number): string[] {
    const cache = item.cache;
    if (cache?.width === width && cache.version === item.version && cache.raw === this.raw && cache.theme === theme) {
      return cache.lines;
    }

    const lines: string[] = [];
    if (separated) lines.push(theme.fg("borderMuted", "─".repeat(Math.min(width, 24))));
    const color = item.kind === "user" ? "accent" : item.kind === "system" ? "dim" : "text";
    const state = item.toolState
      ? item.toolState === "running"
        ? theme.fg("warning", " ●")
        : item.toolState === "error"
          ? theme.fg("error", " ✗")
          : theme.fg("success", " ✓")
      : "";
    lines.push(theme.fg(color, item.label) + state);
    if (item.detail) lines.push(truncateToWidth(theme.fg("muted", item.detail), width));

    // Tool text is already bounded to TOOL_RAW_CAP at ingestion.
    const text =
      item.kind === "tool" && !this.raw && item.text.length > TOOL_NORMAL_CAP
        ? `${item.text.slice(0, TOOL_NORMAL_CAP - 3)}...`
        : item.text;
    if (text.trim()) {
      for (const line of wrapTextWithAnsi(text.trim(), width)) lines.push(truncateToWidth(line, width));
    }
    item.cache = { width, version: item.version, raw: this.raw, theme, lines };
    return lines;
  }
}
