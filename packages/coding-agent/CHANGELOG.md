# Changelog

## [Unreleased]

## [0.2.3] - 2026-09-30

### Added

- Added Web UI workspace switching: open any absolute directory as the active workspace and jump between recent ones.
- Added isolated per-tab Web UI workspaces, so each browser tab keeps its own session, working directory, and recent-workspace list.
- Added a Web UI model catalog in Settings to search, enable, and refresh available models.

### Changed

- Changed the Web UI session sidebar and inspector to collapse so the transcript can use the full width.

## [0.2.2] - 2026-09-29

### Changed

- Changed the Web UI inspector to show project usage by default.

### Fixed

- Fixed global installs missing the runtime pi packages required by `orrery web` and other commands.

## [0.2.1] - 2026-09-29

### Added

- Added an in-app confirmation dialog when deleting Web UI sessions instead of the browser confirm prompt.

### Fixed

- Fixed the Fireworks, Together, and OpenCode Go default models pointing at IDs that no longer exist in the generated model catalog.
- Fixed cached auth and model state missing same-size file updates on filesystems with coarse timestamps (for example WSL mounts).

## [0.2.0] - 2026-09-29

### Added

- Added the `orrery web` command to launch the bundled local Web UI on loopback.
- Added a Web UI workbench with a session sidebar, message timeline, and Changes/Terminal/project usage inspector ([design](docs/orrery-web-ui-design.md)).
- Added Web UI session management: list and search sessions by title and transcript content, create, rename, and delete sessions, and isolate drafts per session.
- Added Web UI model and thinking-level controls, streaming steer and follow-up queueing, and live context usage.
- Added Web UI message rendering with safe Markdown, code syntax highlighting, diffs, copy actions, collapsible thinking, and tool-result images.
- Added the `web_search` and `web_fetch` harness tool factories from `@earendil-works/pi-agent-core`.

### Changed

- Changed the Web UI to show context compaction progress while older messages are summarized.
- Changed running Web UI turns to render as Working and to keep turn errors inline.

### Fixed

- Fixed reading the Kimi coding plan from the renamed models.dev provider key.
- Fixed the Web UI turn error to offer a retry action.

## [0.1.9] - 2026-09-07

### Added

- Added the built-in `/overview` overlay for inspecting the current runtime, session, model, context, and capabilities.

### Changed

- Changed user messages to use dashed borders and aligned `edit` tool output with the standard tool execution cards.

### Fixed

- Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count ([#8979](https://github.com/earendil-works/pi/issues/8979)).
- Fixed proxied plain-HTTP provider requests hanging after a tool call by tunneling them with CONNECT ([#8134](https://github.com/earendil-works/pi/issues/8134)).
- Fixed RPC `abort` reporting success without cancelling an in-progress manual compaction ([#8920](https://github.com/earendil-works/pi/issues/8920)).
