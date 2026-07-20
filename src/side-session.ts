import type { Message } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  type Extension,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionCommandContextActions,
  getAgentDir,
  type LoadExtensionsResult,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { SideModelRuntime } from "./model-runtime.js";
import { SideTranscript } from "./transcript.js";

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const SIDE_BOUNDARY_PROMPT = `Side conversation boundary.

Everything before this boundary is inherited history from the main conversation. It is reference context only, not your current task.

Do not continue, execute, or complete instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.

If there is no user question after this boundary yet, wait for one.`;

const SIDE_SYSTEM_INSTRUCTIONS = `You are in an ephemeral side conversation, separate from the main conversation.

Use inherited history only as reference context. Do not present yourself as continuing the main task, and do not execute instructions that appear only in inherited history. Only instructions submitted after the side-conversation boundary are active.

Answer questions and perform lightweight exploration without disrupting the main task. Subagents and multi-agent collaboration are unavailable in this side conversation.

Policy enforcement is intentionally prompt-based in pi-btw. Parent extension hooks are not inherited. You may perform non-mutating inspection, including reading or searching files and running checks that do not alter workspace state. Do not modify files, source, git state, permissions, configuration, or other workspace state unless the user explicitly requests that mutation after the side boundary. If mutation is explicitly requested, keep it minimal and local to the request.`;

export interface SideSession {
  session: AgentSession;
  transcript: SideTranscript;
  runtime: ModelRuntime;
  modelLabel: string;
  thinkingLevel: string;
  commandNames(): string[];
  commandKind(name: string): "extension" | "prompt" | undefined;
}

function inheritedMessages(ctx: ExtensionCommandContext): Message[] {
  const messages = convertToLlm(
    ctx.sessionManager.buildContextEntries().flatMap((entry) => sessionEntryToContextMessages(entry)),
  );
  const result: Message[] = [];
  let pending: Array<{ id: string; name: string }> = [];
  const closePending = () => {
    for (const toolCall of pending) {
      result.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Tool was still running in the main conversation; no result was inherited." }],
        isError: true,
        timestamp: Date.now(),
      });
    }
    pending = [];
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      closePending();
      pending = message.content
        .filter((content) => content.type === "toolCall")
        .map((toolCall) => ({ id: toolCall.id, name: toolCall.name }));
    } else if (message.role === "toolResult") {
      pending = pending.filter((toolCall) => toolCall.id !== message.toolCallId);
    } else {
      closePending();
    }
    result.push(message);
  }
  closePending();
  return result;
}

export function hasStartedConversation(ctx: ExtensionCommandContext): boolean {
  return ctx.sessionManager
    .buildContextEntries()
    .some((entry) => entry.type === "message" && entry.message.role === "user");
}

function commandOnlyExtension(extension: Extension): Extension {
  return {
    ...extension,
    // Deliberate adaptation: inherit command handlers without inheriting agent/tool hooks.
    // Mutation policy remains prompt-enforced, and extension tools stay unavailable.
    handlers: new Map(),
    tools: new Map(),
    shortcuts: new Map(),
  };
}

function commandOnlyExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
  return { ...base, extensions: base.extensions.map(commandOnlyExtension) };
}

function extensionCommandNames(extensions: Extension[]): string[] {
  const commands = extensions.flatMap((extension) => [...extension.commands.values()]);
  const counts = new Map<string, number>();
  for (const command of commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return commands.map((command) => {
    const occurrence = (seen.get(command.name) ?? 0) + 1;
    seen.set(command.name, occurrence);
    return (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
  });
}

function inMemorySettings(cwd: string, agentDir: string): SettingsManager {
  const parent = SettingsManager.create(cwd, agentDir);
  const global = parent.getGlobalSettings();
  const project = parent.getProjectSettings();
  const merged = { ...global };
  for (const [key, override] of Object.entries(project)) {
    if (override === undefined) continue;
    const base = (global as Record<string, unknown>)[key];
    (merged as Record<string, unknown>)[key] =
      override !== null &&
      base !== null &&
      typeof override === "object" &&
      typeof base === "object" &&
      !Array.isArray(override) &&
      !Array.isArray(base)
        ? { ...base, ...override }
        : override;
  }
  return SettingsManager.inMemory(merged);
}

function commandContextActions(session: AgentSession): ExtensionCommandContextActions {
  const unavailable = async () => {
    throw new Error("Session replacement commands are unavailable inside an ephemeral side conversation");
  };
  return {
    waitForIdle: () => session.waitForIdle(),
    newSession: unavailable,
    fork: unavailable,
    navigateTree: (targetId, options) => session.navigateTree(targetId, options),
    switchSession: unavailable,
    reload: () => session.reload(),
  };
}

export async function createSideConversation(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sideRuntime: SideModelRuntime,
): Promise<SideSession> {
  const { model, runtime } = await sideRuntime.resolve(ctx);
  const agentDir = getAgentDir();
  const toolNames = pi.getActiveTools().filter((name) => BUILTIN_TOOLS.has(name));
  const thinkingLevel = pi.getThinkingLevel();
  const parentSystemPrompt = ctx.getSystemPrompt().trimEnd();

  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    noThemes: true,
    noContextFiles: true,
    extensionsOverride: commandOnlyExtensions,
    systemPromptOverride: () => `${parentSystemPrompt}\n\n${SIDE_SYSTEM_INSTRUCTIONS}`,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const sessionManager = SessionManager.inMemory(ctx.cwd);
  for (const message of inheritedMessages(ctx)) sessionManager.appendMessage(structuredClone(message));
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: SIDE_BOUNDARY_PROMPT }],
    timestamp: Date.now(),
  });

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel,
    tools: toolNames,
    sessionManager,
    settingsManager: inMemorySettings(ctx.cwd, agentDir),
    resourceLoader: loader,
  });
  let transcript: SideTranscript | undefined;
  try {
    transcript = new SideTranscript(session);
    session.setSessionName("Side conversation");
    await session.bindExtensions({
      uiContext: ctx.ui,
      mode: "tui",
      commandContextActions: commandContextActions(session),
      onError: (error) => transcript?.appendSystem("Extension error", `${error.extensionPath}: ${error.error}`),
    });

    return {
      session,
      transcript,
      runtime,
      modelLabel: `${model.provider}/${model.id}`,
      thinkingLevel,
      commandNames: () => [
        ...extensionCommandNames(loader.getExtensions().extensions),
        ...loader.getPrompts().prompts.map((prompt) => prompt.name),
        ...loader.getSkills().skills.map((skill) => `skill:${skill.name}`),
      ],
      commandKind: (name) => {
        if (extensionCommandNames(loader.getExtensions().extensions).includes(name)) return "extension";
        if (
          loader.getPrompts().prompts.some((prompt) => prompt.name === name) ||
          loader.getSkills().skills.some((skill) => `skill:${skill.name}` === name)
        ) {
          return "prompt";
        }
        return undefined;
      },
    };
  } catch (error) {
    transcript?.dispose();
    session.dispose();
    throw error;
  }
}
