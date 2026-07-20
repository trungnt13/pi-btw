import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { SideModelRuntime } from "./model-runtime.js";
import { createSideConversation, hasStartedConversation, type SideSession } from "./side-session.js";
import { type ParentStatus, SideView } from "./side-view.js";

const OWNER_KEY = Symbol.for("pi-btw:root-owner");
const STATUS_KEY = "pi-btw";
const CLOSE_TIMEOUT_MS = 5_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LOCAL_COMMANDS = [
  "model",
  "thinking",
  "compact",
  "status",
  "usage",
  "copy",
  "diff",
  "raw",
  "mention",
  "commands",
  "quit",
  "exit",
] as const;

interface ActiveSide extends SideSession {
  ctx: ExtensionCommandContext;
  view?: SideView;
  done?: () => void;
  promptGate: Promise<void>;
  closeAttempt?: Promise<void>;
  disposePromise?: Promise<void>;
  closing: boolean;
}

interface SlashInput {
  name: string;
  args: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSlashInput(text: string): SlashInput | undefined {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1], args: match[2]?.trim() ?? "" } : undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class SideController {
  private readonly runtime = new SideModelRuntime();
  private active?: ActiveSide;
  private opening = false;
  private openingPromise?: Promise<void>;
  private parentOutcome?: ParentStatus;

  constructor(private readonly pi: ExtensionAPI) {}

  async open(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/side and /btw require interactive TUI mode", "error");
      return;
    }
    if (this.opening || this.active) {
      ctx.ui.notify("A side conversation is already open", "error");
      return;
    }
    if (!ctx.model) {
      ctx.ui.notify("No model is active in the main conversation", "error");
      return;
    }
    if (!hasStartedConversation(ctx)) {
      ctx.ui.notify("Start the main conversation before opening /btw or /side", "error");
      return;
    }

    this.opening = true;
    let settleOpening!: () => void;
    this.openingPromise = new Promise<void>((resolve) => {
      settleOpening = resolve;
    });
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "Side starting"));
    let active: ActiveSide | undefined;
    try {
      const side = await createSideConversation(this.pi, ctx, this.runtime);
      const opened: ActiveSide = { ...side, ctx, promptGate: Promise.resolve(), closing: false };
      active = opened;
      this.active = opened;
      this.opening = false;
      settleOpening();
      this.openingPromise = undefined;
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "Side active"));
      const initialPrompt = args.trim();

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          opened.done = () => done(undefined);
          const view = new SideView({
            tui,
            theme,
            transcript: opened.transcript,
            modelLabel: opened.modelLabel,
            thinkingLevel: opened.thinkingLevel,
            parentStatus: ctx.isIdle() ? undefined : "running",
            isStreaming: () => opened.session.isStreaming,
            onSubmit: (text) => this.queueInput(opened, text),
            onAbort: () => this.abortTurn(opened),
            onClose: () => this.requestClose(opened),
          });
          opened.view = view;
          if (initialPrompt) queueMicrotask(() => this.queueInput(opened, initialPrompt));
          return view;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "92%",
            minWidth: 40,
            maxHeight: "85%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    } catch (error) {
      ctx.ui.notify(`Failed to start side conversation: ${errorMessage(error)}`, "error");
    } finally {
      this.opening = false;
      settleOpening();
      this.openingPromise = undefined;
      if (active && this.active === active) await this.forceDispose(active);
      else if (!active) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  parentStarted(): void {
    this.parentOutcome = undefined;
    const active = this.active;
    active?.view?.setParentStatus("running");
    active?.transcript.appendSystem(
      "Main status",
      "Main conversation started running. Prefer read-only inspection; mutation can race the main agent on the shared working directory.",
    );
  }

  parentAssistantStopped(stopReason: string): void {
    if (stopReason === "error") this.parentOutcome = "failed";
    else if (stopReason === "aborted") this.parentOutcome = "interrupted";
  }

  parentSettled(): void {
    this.active?.view?.setParentStatus(this.parentOutcome ?? "finished");
  }

  async dispose(): Promise<void> {
    if (this.openingPromise) await this.openingPromise;
    const active = this.active;
    if (!active) return;
    await this.forceDispose(active);
    active.done?.();
  }

  private queueInput(active: ActiveSide, text: string): void {
    if (this.active !== active || active.closing) return;
    active.promptGate = active.promptGate
      .then(() => this.routeInput(active, text))
      .catch((error) => {
        if (this.active === active && !active.closing) {
          active.view?.patch({ notice: undefined, error: errorMessage(error) });
        }
      });
  }

  private async routeInput(active: ActiveSide, text: string): Promise<void> {
    if (this.active !== active || active.closing) return;
    active.view?.patch({ error: undefined, notice: undefined });
    const slash = parseSlashInput(text);
    if (!slash) {
      await this.acceptPrompt(active, text, true);
      return;
    }
    if (slash.name === "side" || slash.name === "btw") {
      throw new Error("Nested side conversations are not allowed");
    }

    switch (slash.name) {
      case "model":
        await this.selectModel(active, slash.args);
        return;
      case "thinking":
        await this.selectThinking(active, slash.args);
        return;
      case "compact":
        await this.compact(active);
        return;
      case "status":
      case "usage":
        this.showStatus(active);
        return;
      case "copy":
        await this.copyLastResponse(active);
        return;
      case "diff":
        await this.showDiff(active);
        return;
      case "raw":
        this.toggleRaw(active, slash.args);
        return;
      case "mention":
        if (!slash.args) throw new Error("Usage: /mention <path>");
        await this.acceptPrompt(active, `Please inspect @${slash.args}`, true);
        return;
      case "commands":
        this.showCommands(active);
        return;
      case "quit":
      case "exit":
        this.requestClose(active);
        return;
    }

    const kind = active.commandKind(slash.name);
    if (!kind) throw new Error(`Slash command /${slash.name} is unavailable inside this side conversation`);
    await this.acceptPrompt(active, text, true, kind === "extension");
    if (kind === "extension") this.syncPresentation(active);
  }

  private async acceptPrompt(
    active: ActiveSide,
    text: string,
    expandPromptTemplates: boolean,
    waitForCompletion = false,
  ): Promise<void> {
    if (this.active !== active || active.closing) return;
    let resolvePreflight: (accepted: boolean) => void = () => {};
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    const options: PromptOptions = { expandPromptTemplates, preflightResult: resolvePreflight };
    if (active.session.isStreaming) options.streamingBehavior = "steer";

    const run = active.session.prompt(text, options);
    void run.catch((error) => {
      if (this.active === active && !active.closing) active.view?.setError(errorMessage(error));
    });
    await preflight;
    if (waitForCompletion) await run;
  }

  private syncPresentation(active: ActiveSide): void {
    const model = active.session.model;
    if (model) active.modelLabel = `${model.provider}/${model.id}`;
    active.thinkingLevel = active.session.thinkingLevel;
    active.view?.patch({ modelLabel: active.modelLabel, thinkingLevel: active.thinkingLevel });
  }

  private async selectModel(active: ActiveSide, requested: string): Promise<void> {
    if (active.session.isStreaming) throw new Error("Wait for or abort the active side turn before changing model");
    const available = [...(await active.runtime.getAvailable())].sort((left, right) =>
      `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
    );
    let key = requested;
    if (!key) {
      key =
        (await active.ctx.ui.select(
          "Side model",
          available.map((model) => `${model.provider}/${model.id}`),
        )) ?? "";
      if (!key) return;
    }
    const slash = key.indexOf("/");
    const matches =
      slash === -1
        ? available.filter((model) => model.id === key)
        : available.filter((model) => model.provider === key.slice(0, slash) && model.id === key.slice(slash + 1));
    if (matches.length !== 1) throw new Error(`Model must resolve uniquely: ${key}`);
    const model = matches[0];
    await active.session.setModel(model);
    this.syncPresentation(active);
    active.transcript.appendSystem("Model", `Switched to ${active.modelLabel}`);
  }

  private async selectThinking(active: ActiveSide, requested: string): Promise<void> {
    if (active.session.isStreaming) throw new Error("Wait for or abort the active side turn before changing thinking");
    const model = active.session.model;
    if (!model) throw new Error("No side model is active");
    const supported = getSupportedThinkingLevels(model);
    let level = requested;
    if (!level) level = (await active.ctx.ui.select("Side thinking", [...supported])) ?? "";
    if (!level) return;
    if (
      !THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number]) ||
      !supported.includes(level as ModelThinkingLevel)
    ) {
      throw new Error(`Thinking level is unsupported by ${model.provider}/${model.id}: ${level}`);
    }
    active.session.setThinkingLevel(level as ModelThinkingLevel);
    active.thinkingLevel = level;
    active.view?.patch({ thinkingLevel: level });
    active.transcript.appendSystem("Thinking", `Set to ${level}`);
  }

  private async compact(active: ActiveSide): Promise<void> {
    if (active.session.isStreaming) throw new Error("Wait for or abort the active side turn before compacting");
    active.view?.setNotice("Compacting side context...");
    await active.session.compact();
    active.view?.setNotice("Side context compacted; transcript preserved");
  }

  private showStatus(active: ActiveSide): void {
    const stats = active.session.getSessionStats();
    const sideMessages = Math.max(0, stats.totalMessages - active.baselineMessageCount);
    active.view?.setNotice(
      `${active.modelLabel} · ${active.session.thinkingLevel} · side ${sideMessages} msgs · total ${stats.totalMessages} msgs · ${stats.tokens.total} tokens · $${stats.cost.toFixed(4)}`,
    );
  }

  private async copyLastResponse(active: ActiveSide): Promise<void> {
    const text = active.transcript.lastAssistantText();
    if (!text) throw new Error("No side response is available to copy");
    await copyToClipboard(text);
    active.view?.setNotice("Copied the last side response");
  }

  private async showDiff(active: ActiveSide): Promise<void> {
    const [status, diff] = await Promise.all([
      this.pi.exec("git", ["status", "--short"], { timeout: 10_000 }),
      this.pi.exec("git", ["diff", "--no-ext-diff", "--stat"], { timeout: 10_000 }),
    ]);
    if (status.code !== 0) throw new Error(status.stderr || "git status failed");
    if (diff.code !== 0) throw new Error(diff.stderr || "git diff failed");
    active.transcript.appendSystem(
      "Git diff",
      [status.stdout.trim(), diff.stdout.trim()].filter(Boolean).join("\n\n") || "Clean",
    );
  }

  private toggleRaw(active: ActiveSide, requested: string): void {
    const normalized = requested.toLowerCase();
    if (normalized && normalized !== "on" && normalized !== "off") throw new Error("Usage: /raw [on|off]");
    const raw = normalized === "on" ? true : normalized === "off" ? false : !active.transcript.isRaw();
    active.transcript.setRaw(raw);
    active.view?.setNotice(`Raw tool output ${raw ? "enabled" : "disabled"}`);
  }

  private showCommands(active: ActiveSide): void {
    const inherited = active.commandNames().sort();
    active.view?.setNotice(
      `Local: ${LOCAL_COMMANDS.map((name) => `/${name}`).join(", ")} · inherited: ${inherited.length}`,
    );
    active.transcript.appendSystem("Inherited commands", inherited.map((name) => `/${name}`).join("\n") || "None");
  }

  private abortTurn(active: ActiveSide): void {
    if (this.active !== active || active.closing) return;
    active.view?.setNotice("Aborting side turn...");
    active.session.clearQueue();
    void active.session.abort().then(
      () => active.view?.setNotice("Side turn aborted"),
      (error) => active.view?.setError(`Failed to abort: ${errorMessage(error)}`),
    );
  }

  private requestClose(active: ActiveSide): void {
    if (this.active !== active || active.closeAttempt) return;
    active.closing = true;
    active.view?.setClosing(true);
    active.closeAttempt = (async () => {
      const failure = await this.settle(active, CLOSE_TIMEOUT_MS);
      if (failure) {
        active.closing = false;
        active.view?.patch({ closing: false, error: `Side remains open: ${failure}` });
        return;
      }
      await this.disposeActive(active);
      active.done?.();
    })().finally(() => {
      active.closeAttempt = undefined;
    });
  }

  private async forceDispose(active: ActiveSide): Promise<void> {
    active.closing = true;
    await this.settle(active, CLOSE_TIMEOUT_MS);
    await this.disposeActive(active);
  }

  private async settle(active: ActiveSide, timeoutMs: number): Promise<string | undefined> {
    active.closing = true;
    active.session.clearQueue();

    const work = (async () => {
      if (active.session.isStreaming || !active.session.isIdle) {
        await active.session.abort();
      }
      await active.session.waitForIdle();
      await active.promptGate.catch(() => undefined);
    })();

    try {
      await withTimeout(work, timeoutMs, "side settle");
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private disposeActive(active: ActiveSide): Promise<void> {
    if (active.disposePromise) return active.disposePromise;
    active.disposePromise = Promise.resolve().then(() => {
      active.view?.markClosed();
      active.transcript.dispose();
      active.session.dispose();
      active.restoreUi();
      if (this.active === active) this.active = undefined;
      active.ctx.ui.setStatus(STATUS_KEY, undefined);
    });
    return active.disposePromise;
  }
}

export default function piBtw(pi: ExtensionAPI): void {
  if ((globalThis as Record<PropertyKey, unknown>)[OWNER_KEY] !== undefined) return;
  const owner = {};
  (globalThis as Record<PropertyKey, unknown>)[OWNER_KEY] = owner;

  const controller = new SideController(pi);
  const handler = (args: string, ctx: ExtensionCommandContext) => controller.open(args, ctx);

  try {
    pi.registerCommand("btw", {
      description: "Start a high-performance ephemeral side conversation",
      handler,
    });
    pi.registerCommand("side", { description: "Alias for /btw", handler });
    pi.on("agent_start", () => controller.parentStarted());
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") controller.parentAssistantStopped(event.message.stopReason);
    });
    pi.on("agent_settled", () => controller.parentSettled());
    pi.on("session_shutdown", async () => {
      try {
        await controller.dispose();
      } finally {
        if ((globalThis as Record<PropertyKey, unknown>)[OWNER_KEY] === owner) {
          delete (globalThis as Record<PropertyKey, unknown>)[OWNER_KEY];
        }
      }
    });
  } catch (error) {
    if ((globalThis as Record<PropertyKey, unknown>)[OWNER_KEY] === owner) {
      delete (globalThis as Record<PropertyKey, unknown>)[OWNER_KEY];
    }
    throw error;
  }
}
