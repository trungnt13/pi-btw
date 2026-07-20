# pi-btw

A high-performance Pi extension for temporary conversations that do not interrupt or persist in the main thread. `/btw` and `/side` are exact aliases.

`pi-btw` is designed as a Pi-native utility, not as an emulation of another agent's thread model.

## What it does

- Snapshots **finalized** main-thread context at `/btw` open into an in-memory `AgentSession` (in-flight partial assistant text is excluded until parent `message_end`).
- Keeps the main agent running while the side overlay is active.
- Shares the parent's exact model runtime identity for stream/auth, while blocking side-session provider registration.
- Inherits the parent's selected model, thinking level, and active tools whose static definitions can be rediscovered with matching provenance (source/path/scope/origin). Name-only collisions that would silently replace a sandbox override with a stock built-in are refused.
- Honors the parent's project-trust decision for resource discovery and settings.
- Prints an inheritance summary at open: model, tools, unavailable tools with reasons, context snapshot details, command/skill counts, and trust/running state.
- Supports side-local model changes across providers available from the parent runtime without changing persistent Pi defaults.
- Keeps inherited history available to the model but hidden from the side transcript.
- Preserves the visible transcript across automatic and manual context compaction.
- Closes unresolved parent tool calls with side-only synthetic error results when the snapshot is taken mid-tool.
- Discards the entire side session on close; no side messages enter the main session JSONL.

Rendering is event-driven. Finalized transcript blocks cache their wrapped lines, transcript heights use a dirty-suffix index for viewport extraction, and the whole overlay frame is memoized so concurrent main-thread paints skip unchanged side UI.

## Load

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-btw/src/index.ts
```

For automatic discovery, install or link the package through Pi settings.

`pi-btw` currently pins Pi `0.80.10` because it deliberately shares the parent `ModelRegistry.runtime` identity instead of cloning provider state.

## Usage

```text
/btw
/btw explain why the current approach uses a queue
/side check whether this API is public
```

The bare command opens an empty side conversation. Inline text becomes the first side prompt.

Inside the overlay:

- `Enter` submits; `Shift+Enter` inserts a newline.
- `PageUp`/`PageDown` or `Alt+Up`/`Alt+Down` scroll.
- `Escape` aborts the active side turn and clears queued steering/follow-up.
- Empty-editor `Ctrl+C` or `Ctrl+D` returns to the main thread.

## Slash commands

Side-local interactive commands:

```text
/model [provider/model]   select or set any available model
/thinking [level]         select or set a supported thinking level
/compact                  compact model context without losing the transcript
/status, /usage           show side-session usage (side vs total message counts)
/copy                     copy the last successful assistant response
/diff                     show current git status and diff summary
/raw [on|off]             toggle expanded tool output
/mention <path>           ask the side model to inspect a path
/commands                 list inherited commands
/quit, /exit              return to the main thread
```

Parent extension commands, prompt templates, and skills are rediscovered into the child and execute against the side session. Skills use the same `/skill:name` form as the main thread. Parent extensions are imported **without event hooks or shortcuts**: command handlers and tool definitions are kept; lifecycle/approval handlers are stripped. Commands or tools that depend on stripped lifecycle hooks may be unavailable and are listed when possible.

Pi does not expose its interactive-mode built-in command dispatcher to extensions. Built-ins not implemented above are therefore rejected rather than sent to the model. Nested `/side` and `/btw` are always rejected. Session-replacement actions and parent-chrome UI mutations requested by inherited extension commands are also rejected because a side session is intentionally ephemeral.

## Isolation and mutation policy

The side model receives a snapshot of the parent system prompt plus an explicit side boundary. Context files such as `AGENTS.md` are **not** reloaded into the child; they are present only if already embedded in that parent system-prompt snapshot. Parent extension hooks—including approval and tool-policy hooks—are not cloned. This is an intentional adaptation, not an enforcement guarantee:

1. inherited pre-boundary instructions are reference context only;
2. inspection is allowed;
3. workspace mutation requires an explicit post-boundary user request;
4. side and main always share one working directory; when main is running at open (or starts later), the UI and transcript warn that mutation can race the main agent.

Active parent tools remain available only when their rediscovered definitions match parent provenance. The model is constrained by the side instructions above, not by a hard permission sandbox or FS lock. Disable mutating parent tools before opening `/btw` or `/side`, or wait until main is idle, when prompt-only policy is insufficient for the environment.

## Limits

- Only one side overlay may be open per Pi process.
- Context inheritance is a point-in-time snapshot of **finalized** parent messages at open; later parent messages are not pulled in live.
- Dynamic/SDK/CLI-only tools and lifecycle-dependent extension resources cannot always be reconstructed; they appear under “not available” rather than being silently substituted.
- Parent status reporting is limited to running, finished, failed, and interrupted; Pi exposes no generic parent approval/input events to extensions.
- Extension factories still run while Pi discovers inherited commands. Extension authors should keep factory registration side-effect free, as required by Pi's extension model. Side sessions block provider registration against the shared runtime.
- Interactive close clears queues, aborts streaming work, and waits for idle under a five-second bound. If settlement fails or times out, the overlay stays visible. Parent shutdown uses the same bound, then disposes unconditionally.
