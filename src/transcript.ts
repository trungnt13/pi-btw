import type { AgentSession, AgentSessionEvent, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type ItemKind = "user" | "assistant" | "tool" | "system";
type ToolState = "running" | "success" | "error";

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

function previewArguments(value: unknown): string {
  const serialized = JSON.stringify(value) ?? "";
  return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
}

export class SideTranscript {
  private readonly items: TranscriptItem[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly tools = new Map<string, TranscriptItem>();
  private readonly unsubscribe: () => void;
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
      if (item.kind === "assistant" && item.text.trim()) return item.text.trim();
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

    let totalLines = 0;
    for (let index = 0; index < this.items.length; index++) {
      totalLines += this.renderItem(this.items[index], index > 0, theme, width).length;
    }
    const start = Math.min(Math.max(0, requestedStart), Math.max(0, totalLines - count));
    const end = start + count;
    const lines: string[] = [];
    let offset = 0;
    for (let index = 0; index < this.items.length; index++) {
      const itemLines = this.renderItem(this.items[index], index > 0, theme, width);
      const itemEnd = offset + itemLines.length;
      if (itemEnd > start && offset < end) {
        lines.push(...itemLines.slice(Math.max(0, start - offset), Math.min(itemLines.length, end - offset)));
      }
      offset = itemEnd;
      if (offset >= end) break;
    }
    return { lines, totalLines, start };
  }

  invalidate(): void {
    for (const item of this.items) item.cache = undefined;
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
        this.currentAssistant = this.append({ kind: "assistant", label: "Side", text: "" });
      } else if (event.message.role === "custom" && event.message.display) {
        this.append({ kind: "system", label: event.message.customType, text: contentText(event.message.content) });
      }
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const item = this.currentAssistant ?? this.append({ kind: "assistant", label: "Side", text: "" });
      this.currentAssistant = item;
      this.update(item, item.text + event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = contentText(event.message.content);
      const item = this.currentAssistant ?? this.append({ kind: "assistant", label: "Side", text });
      if (item.text !== text && (text || !event.message.errorMessage)) this.update(item, text);
      if (event.message.errorMessage) {
        if (item.text.trim())
          this.append({ kind: "system", label: "Response error", text: event.message.errorMessage });
        else this.update(item, event.message.errorMessage);
      }
      this.currentAssistant = undefined;
      return;
    }

    if (event.type === "tool_execution_start") {
      const detail = previewArguments(event.args);
      const item = this.append({
        kind: "tool",
        label: event.toolName,
        text: "Running...",
        detail,
        toolState: "running",
      });
      this.tools.set(event.toolCallId, item);
      return;
    }

    if (event.type === "tool_execution_update") {
      const item = this.tools.get(event.toolCallId);
      const text = contentText(event.partialResult.content);
      if (item && text) this.update(item, text);
      return;
    }

    if (event.type === "tool_execution_end") {
      const item = this.tools.get(event.toolCallId);
      if (!item) return;
      const text = contentText(event.result.content) || "(no output)";
      item.toolState = event.isError ? "error" : "success";
      this.update(item, text);
      this.tools.delete(event.toolCallId);
      return;
    }

    if (event.type === "compaction_end" && !event.aborted && event.result) {
      this.append({ kind: "system", label: "Context compacted", text: event.reason });
    } else if (event.type === "auto_retry_start") {
      this.append({ kind: "system", label: `Retry ${event.attempt}/${event.maxAttempts}`, text: event.errorMessage });
    }
  }

  private append(input: Omit<TranscriptItem, "id" | "version">): TranscriptItem {
    const item: TranscriptItem = { ...input, id: this.nextId++, version: 1 };
    this.items.push(item);
    this.notify();
    return item;
  }

  private update(item: TranscriptItem, text: string): void {
    item.text = text;
    item.version++;
    item.cache = undefined;
    this.notify();
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

    const limit = this.raw ? 10_000 : 1_500;
    const text = item.kind === "tool" && item.text.length > limit ? `${item.text.slice(0, limit - 3)}...` : item.text;
    if (text.trim()) {
      for (const line of wrapTextWithAnsi(text.trim(), width)) lines.push(truncateToWidth(line, width));
    }
    item.cache = { width, version: item.version, raw: this.raw, theme, lines };
    return lines;
  }
}
