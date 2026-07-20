# pi-btw

A high-performance Pi extension for temporary conversations that do not interrupt or persist in the main thread. `/btw` and `/side` are exact aliases.

`pi-btw` is designed as a Pi-native utility, not as an emulation of another agent's thread model.

## What it does

- Forks completed main-thread context into an in-memory `AgentSession`.
- Keeps the main agent running while the side overlay is active.
- Uses the parent's exact model runtime, selected model, thinking level, and active Pi built-in tools.
- Supports side-local model changes across every provider available to the parent runtime without changing persistent Pi defaults.
- Keeps inherited history available to the model but hidden from the side transcript.
- Preserves the visible transcript across automatic and manual context compaction.
- Closes unresolved parent tool calls with side-only synthetic error results when the snapshot is taken mid-tool.
- Discards the entire side session on close; no side messages enter the main session JSONL.

Rendering is event-driven. Finalized transcript blocks cache their wrapped lines, streaming invalidates only the active block, viewport extraction avoids rebuilding the complete transcript, and redraw requests are coalesced to one per 16 ms.

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
- `Escape` aborts the active side turn.
- Empty-editor `Ctrl+C` or `Ctrl+D` returns to the main thread.

## Slash commands

Side-local interactive commands:

```text
/model [provider/model]   select or set any available model
/thinking [level]         select or set a supported thinking level
/compact                  compact model context without losing the transcript
/status, /usage           show side-session usage
/copy                     copy the last assistant response
/diff                     show current git status and diff summary
/raw [on|off]             toggle expanded tool output
/mention <path>           ask the side model to inspect a path
/commands                 list inherited commands
/quit, /exit              return to the main thread
```

Parent extension commands, prompt templates, and skills are loaded into the child and execute against the side session. They are imported in **command-only mode**: tools, shortcuts, and event hooks from parent extensions are intentionally removed.

Pi does not expose its interactive-mode built-in command dispatcher to extensions. Built-ins not implemented above are therefore rejected rather than sent to the model. Nested `/side` and `/btw` are always rejected. Session-replacement actions requested by inherited extension commands are also rejected because a side session is intentionally ephemeral.

## Isolation and mutation policy

The side model receives the parent system prompt plus an explicit side boundary. Parent extension hooks—including approval and tool-policy hooks—are not cloned. This is an intentional adaptation, not an enforcement guarantee:

1. inherited pre-boundary instructions are reference context only;
2. inspection is allowed;
3. workspace mutation requires an explicit post-boundary user request.

When mutating built-in tools are active in the parent, they remain technically available in the side session. The model is constrained by the side instructions above, not by a hard permission sandbox. Disable mutating parent tools before opening `/btw` or `/side` when prompt-only policy is insufficient for the environment.

## Limits

- Only one side overlay may be open per Pi process.
- Parent status reporting is limited to running, finished, failed, and interrupted; Pi exposes no generic parent approval/input events to extensions.
- Extension factories still run while Pi discovers inherited commands. Extension authors should keep factory registration side-effect free, as required by Pi's extension model.
- Interactive close keeps the overlay visible if abort settlement fails or exceeds five seconds. Parent shutdown uses the same bound, then disposes unconditionally.
