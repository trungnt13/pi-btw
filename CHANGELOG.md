# Changelog

## [Unreleased]

### Changed

- Renamed the package and extension from `pi-side` to `pi-btw`; `/btw` and `/side` remain exact aliases.
- Reframed `pi-btw` as a high-performance Pi-native side utility rather than a Codex-parity implementation.
- Replaced session-index transcript rendering with a compaction-safe, extension-owned event transcript.
- Sanitized mid-tool parent snapshots with side-only synthetic results for unresolved tool calls.
- Made child-session construction transactional and surfaced errors that follow partial assistant output.
- Added per-item wrap caching, viewport-only extraction, and 16 ms render coalescing.
- Added command-only inheritance for parent extension commands, prompt templates, and skills.
- Added side-local `/model`, `/thinking`, `/compact`, `/status`, `/usage`, `/copy`, `/diff`, `/raw`, `/mention`, `/commands`, `/quit`, and `/exit` commands.
- Added exact multi-provider model switching through the shared parent runtime with in-memory settings so side changes never persist as Pi defaults.
- Changed interactive cleanup to keep the overlay visible when abort settlement fails or times out.
- Removed the provider-cloning fallback and fail explicitly when the pinned Pi runtime bridge is unavailable.
- Documented prompt-based mutation policy as an intentional, non-sandboxed design.

## [0.1.0] - 2026-07-20

### Added

- Added ephemeral `/side` conversations and the equivalent `/btw` alias with inherited parent context, concurrent execution, a live interactive overlay, and deterministic cleanup.
