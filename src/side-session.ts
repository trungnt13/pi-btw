import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
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
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { guardSharedRuntime, type SideModelRuntime } from "./model-runtime.js";
import { createSideUi } from "./side-ui.js";
import { SideTranscript } from "./transcript.js";

const PARENT_ONLY_COMMANDS = new Set(["btw", "side"]);

const SIDE_BOUNDARY_PROMPT = `Side conversation boundary.

Everything before this boundary is inherited history from the main conversation. It is reference context only, not your current task.

Do not continue, execute, or complete instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.

If there is no user question after this boundary yet, wait for one.`;

const SIDE_SYSTEM_INSTRUCTIONS = `You are in an ephemeral side conversation, separate from the main conversation.

Use inherited history only as reference context. Do not present yourself as continuing the main task, and do not execute instructions that appear only in inherited history. Only instructions submitted after the side-conversation boundary are active.

Answer questions and perform lightweight exploration without disrupting the main task.

Policy enforcement is intentionally prompt-based in pi-btw. Parent extension hooks are not inherited. You share the main conversation working directory. Prefer non-mutating inspection. Do not modify files, source, git state, permissions, configuration, processes, or other workspace state unless the user explicitly requests that mutation after the side boundary. If mutation is explicitly requested, keep it minimal and local to the request.`;

const CONCURRENT_PARENT_INSTRUCTIONS = `The main conversation is still running and shares this working directory. Do not use tools that mutate files, git state, permissions, configuration, processes, or other workspace state while the main conversation is active. Prefer read-only inspection until the user explicitly requests mutation after the side boundary and understands the concurrency risk.`;

export interface SideSession {
  session: AgentSession;
  transcript: SideTranscript;
  runtime: ModelRuntime;
  modelLabel: string;
  thinkingLevel: string;
  restoreUi: () => void;
  baselineMessageCount: number;
  commandNames(): string[];
  commandKind(name: string): "extension" | "prompt" | undefined;
}

interface InheritedContext {
  messages: Message[];
  closedToolCalls: number;
}

interface ParentSnapshot {
  cwd: string;
  projectTrusted: boolean;
  parentRunning: boolean;
  modelProvider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
  systemPrompt: string;
  activeToolNames: string[];
  parentTools: ToolInfo[];
  parentCommandNames: string[];
  inherited: InheritedContext;
  runtime: ModelRuntime;
}

interface ToolDecision {
  active: string[];
  unavailable: string[];
}

function inheritedMessages(ctx: ExtensionCommandContext): InheritedContext {
  const messages = convertToLlm(
    ctx.sessionManager.buildContextEntries().flatMap((entry) => sessionEntryToContextMessages(entry)),
  );
  const result: Message[] = [];
  let pending: Array<{ id: string; name: string }> = [];
  let closedToolCalls = 0;
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
      closedToolCalls++;
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
  return { messages: result, closedToolCalls };
}

export function hasStartedConversation(ctx: ExtensionCommandContext): boolean {
  return ctx.sessionManager
    .buildContextEntries()
    .some((entry) => entry.type === "message" && entry.message.role === "user");
}

function captureParentSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sideRuntime: SideModelRuntime,
): ParentSnapshot {
  const model = ctx.model;
  if (!model) throw new Error("No model is active in the main conversation");
  return {
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    parentRunning: !ctx.isIdle(),
    modelProvider: model.provider,
    modelId: model.id,
    thinkingLevel: pi.getThinkingLevel(),
    systemPrompt: ctx.getSystemPrompt().trimEnd(),
    activeToolNames: [...pi.getActiveTools()],
    parentTools: pi.getAllTools().map((tool) => ({
      ...tool,
      sourceInfo: { ...tool.sourceInfo },
      promptGuidelines: tool.promptGuidelines ? [...tool.promptGuidelines] : undefined,
    })),
    parentCommandNames: pi.getCommands().map((command) => command.name),
    inherited: inheritedMessages(ctx),
    runtime: sideRuntime.get(ctx.modelRegistry),
  };
}

function commandOnlyExtension(extension: Extension): Extension {
  return {
    ...extension,
    // Keep command handlers and tool definitions. Strip event hooks/shortcuts so parent
    // approval/policy handlers do not run. Lifecycle-dependent tools may still be unavailable.
    handlers: new Map(),
    shortcuts: new Map(),
  };
}

function commandOnlyExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
  base.runtime.pendingProviderRegistrations = [];
  const denyProvider = () => {
    throw new Error("Provider registration is disabled inside pi-btw side sessions");
  };
  base.runtime.registerProvider = denyProvider;
  base.runtime.unregisterProvider = denyProvider;
  return { ...base, extensions: base.extensions.map(commandOnlyExtension) };
}

function toolProvenanceKey(tool: ToolInfo): string {
  const source = tool.sourceInfo;
  return `${tool.name}\0${source.source}\0${source.path}\0${source.scope}\0${source.origin}`;
}

function decideTools(parentTools: ToolInfo[], activeNames: string[], childTools: ToolInfo[]): ToolDecision {
  const parentByName = new Map(parentTools.map((tool) => [tool.name, tool]));
  const childByName = new Map(childTools.map((tool) => [tool.name, tool]));
  const active: string[] = [];
  const unavailable: string[] = [];

  for (const name of activeNames) {
    const parent = parentByName.get(name);
    const child = childByName.get(name);
    if (!parent) {
      unavailable.push(`${name} (missing parent metadata)`);
      continue;
    }
    if (!child) {
      unavailable.push(`${name} (not rediscoverable in side)`);
      continue;
    }
    if (toolProvenanceKey(parent) !== toolProvenanceKey(child)) {
      unavailable.push(
        `${name} (definition mismatch: parent ${parent.sourceInfo.source}:${parent.sourceInfo.path} vs child ${child.sourceInfo.source}:${child.sourceInfo.path})`,
      );
      continue;
    }
    active.push(name);
  }
  return { active, unavailable };
}

function inMemorySettings(cwd: string, agentDir: string, projectTrusted: boolean): SettingsManager {
  const parent = SettingsManager.create(cwd, agentDir, { projectTrusted });
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
  return SettingsManager.inMemory(merged, { projectTrusted });
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

function formatInheritanceSummary(input: {
  modelLabel: string;
  thinkingLevel: string;
  projectTrusted: boolean;
  parentRunning: boolean;
  messageCount: number;
  closedToolCalls: number;
  activeTools: string[];
  unavailableTools: string[];
  extensionCommands: number;
  promptCommands: number;
  skillCommands: number;
  missingCommands: string[];
}): string {
  const lines = [
    `Model: ${input.modelLabel} · thinking ${input.thinkingLevel}`,
    `Tools: ${input.activeTools.join(", ") || "(none)"}`,
    input.unavailableTools.length > 0 ? `Tools not available in side: ${input.unavailableTools.join("; ")}` : undefined,
    `Context: ${input.messageCount} finalized inherited messages · snapshot at /btw open · ${
      input.closedToolCalls > 0
        ? `${input.closedToolCalls} unresolved parent tool call(s) closed with synthetic results`
        : "no unresolved parent tool calls"
    } · parent ${input.parentRunning ? "running (shared cwd)" : "idle"} · project ${input.projectTrusted ? "trusted" : "untrusted"}`,
    "System: parent system-prompt snapshot + side policy. Context files (AGENTS.md, etc.) are not reloaded; they arrive only via that parent snapshot. In-flight partial assistant text is excluded until parent message_end.",
    `Commands: ${input.extensionCommands} extension · ${input.promptCommands} prompt templates · ${input.skillCommands} skills (use /skill:name like the main thread)`,
    input.missingCommands.length > 0
      ? `Parent commands not rediscovered: ${input.missingCommands.map((name) => `/${name}`).join(", ")}`
      : undefined,
    "Caution: side and main share one working directory. Prefer read-only inspection while main is active.",
    input.parentRunning ? "Main is still running now — mutation can race the main agent." : undefined,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export async function createSideConversation(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sideRuntime: SideModelRuntime,
): Promise<SideSession> {
  // Capture one immutable parent snapshot before any await.
  const snapshot = captureParentSnapshot(pi, ctx, sideRuntime);
  const agentDir = getAgentDir();
  const guardedRuntime = guardSharedRuntime(snapshot.runtime);
  const model = await sideRuntime.resolveModel(guardedRuntime, {
    provider: snapshot.modelProvider,
    id: snapshot.modelId,
  });
  const settingsManager = inMemorySettings(snapshot.cwd, agentDir, snapshot.projectTrusted);
  const discoverySettings = SettingsManager.create(snapshot.cwd, agentDir, {
    projectTrusted: snapshot.projectTrusted,
  });
  const systemPrompt = [
    snapshot.systemPrompt,
    SIDE_SYSTEM_INSTRUCTIONS,
    snapshot.parentRunning ? CONCURRENT_PARENT_INSTRUCTIONS : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");

  const loader = new DefaultResourceLoader({
    cwd: snapshot.cwd,
    agentDir,
    settingsManager: discoverySettings,
    noThemes: true,
    // Parent system prompt already embeds loaded context files.
    noContextFiles: true,
    extensionsOverride: commandOnlyExtensions,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const sessionManager = SessionManager.inMemory(snapshot.cwd);
  for (const message of snapshot.inherited.messages) sessionManager.appendMessage(structuredClone(message));
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: SIDE_BOUNDARY_PROMPT }],
    timestamp: Date.now(),
  });

  // Allow only parent-active names; provenance-matched subset is activated after binding.
  const { session } = await createAgentSession({
    cwd: snapshot.cwd,
    agentDir,
    modelRuntime: guardedRuntime,
    model,
    thinkingLevel: snapshot.thinkingLevel,
    tools: snapshot.activeToolNames,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
  });
  let transcript: SideTranscript | undefined;
  let restoreUi = () => {};
  try {
    transcript = new SideTranscript(session);
    session.setSessionName("Side conversation");
    const sideUi = createSideUi(ctx.ui);
    restoreUi = sideUi.restore;
    await session.bindExtensions({
      uiContext: sideUi.ui,
      mode: "tui",
      commandContextActions: commandContextActions(session),
      onError: (error) => transcript?.appendSystem("Extension error", `${error.extensionPath}: ${error.error}`),
    });

    const decision = decideTools(snapshot.parentTools, snapshot.activeToolNames, session.getAllTools());
    session.setActiveToolsByName(decision.active);

    const extensionCommands =
      session.extensionRunner?.getRegisteredCommands().map((command) => command.invocationName) ?? [];
    const promptCommands = loader.getPrompts().prompts.map((prompt) => prompt.name);
    const skillCommands = loader.getSkills().skills.map((skill) => `skill:${skill.name}`);
    const childCommandSet = new Set([...extensionCommands, ...promptCommands, ...skillCommands]);
    const missingCommands = snapshot.parentCommandNames.filter(
      (name) => !PARENT_ONLY_COMMANDS.has(name) && !childCommandSet.has(name),
    );
    const modelLabel = `${model.provider}/${model.id}`;
    const baselineMessageCount = session.messages.length;
    transcript.appendSystem(
      "Inherited",
      formatInheritanceSummary({
        modelLabel,
        thinkingLevel: snapshot.thinkingLevel,
        projectTrusted: snapshot.projectTrusted,
        parentRunning: snapshot.parentRunning,
        messageCount: snapshot.inherited.messages.length,
        closedToolCalls: snapshot.inherited.closedToolCalls,
        activeTools: decision.active,
        unavailableTools: decision.unavailable,
        extensionCommands: extensionCommands.length,
        promptCommands: promptCommands.length,
        skillCommands: skillCommands.length,
        missingCommands,
      }),
    );

    const liveExtensionCommands = () =>
      session.extensionRunner?.getRegisteredCommands().map((command) => command.invocationName) ?? extensionCommands;

    return {
      session,
      transcript,
      runtime: guardedRuntime,
      modelLabel,
      thinkingLevel: snapshot.thinkingLevel,
      restoreUi,
      baselineMessageCount,
      commandNames: () => {
        const live = liveExtensionCommands();
        return [
          ...live,
          ...loader.getPrompts().prompts.map((prompt) => prompt.name),
          ...loader.getSkills().skills.map((skill) => `skill:${skill.name}`),
        ];
      },
      commandKind: (name) => {
        if (liveExtensionCommands().includes(name)) return "extension";
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
    restoreUi();
    transcript?.dispose();
    session.dispose();
    throw error;
  }
}
