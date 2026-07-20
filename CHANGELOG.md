# Changelog

## [Unreleased]

### Changed

- Propagated parent project-trust into side settings and resource discovery.
- Fail-closed tool inheritance by provenance (source/path/scope/origin); refuse silent built-in substitution.
- Captured a synchronous parent snapshot before any await (finalized messages only).
- Blocked side-session provider registration against the shared parent runtime.
- Added scoped parent UI facade that restores keyed status/widgets and rejects chrome mutations.
- Made close/abort a quiescence path: clear queues, abort, wait for idle and prompt gate under 5s.
- Fixed editor cursor clipping, transcript stopReason/compaction/retry terminal states, and status baseline labeling.
- Printed richer open-time inheritance summary (trust, unavailable tool reasons, missing commands).
- Inherited rediscoverable parent active tools (built-in and extension defs) with handlers/shortcuts stripped.
- Renamed the package and extension from `pi-side` to `pi-btw`; `/btw` and `/side` remain exact aliases.
- Reframed `pi-btw` as a high-performance Pi-native side utility rather than a Codex-parity implementation.
- Replaced session-index transcript rendering with a compaction-safe, extension-owned event transcript.
- Sanitized mid-tool parent snapshots with side-only synthetic results for unresolved tool calls.
- Added command/tool inheritance for parent extension commands, prompt templates, and skills without event hooks.
- Added side-local `/model`, `/thinking`, `/compact`, `/status`, `/usage`, `/copy`, `/diff`, `/raw`, `/mention`, `/commands`, `/quit`, and `/exit` commands.
- Added multi-provider model switching through the shared parent runtime with in-memory settings so side changes never persist as Pi defaults.
- Changed interactive cleanup to keep the overlay visible when abort settlement fails or times out.
- Removed the provider-cloning fallback and fail explicitly when the pinned Pi runtime bridge is unavailable.
- Documented prompt-based mutation policy as an intentional, non-sandboxed design.

## [0.1.0] - 2026-07-20

### Added

- Added ephemeral `/side` conversations and the equivalent `/btw` alias with inherited parent context, concurrent execution, a live interactive overlay, and deterministic cleanup.
