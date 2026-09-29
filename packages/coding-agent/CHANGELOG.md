# Changelog

## [Unreleased]

### Added

- Added the `orrery web` command to launch the bundled local Web UI.

## [0.1.9] - 2026-09-07

### Added

- Added the built-in `/overview` overlay for inspecting the current runtime, session, model, context, and capabilities.

### Changed

- Changed user messages to use dashed borders and aligned `edit` tool output with the standard tool execution cards.

### Fixed

- Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count ([#8979](https://github.com/earendil-works/pi/issues/8979)).
- Fixed proxied plain-HTTP provider requests hanging after a tool call by tunneling them with CONNECT ([#8134](https://github.com/earendil-works/pi/issues/8134)).
- Fixed RPC `abort` reporting success without cancelling an in-progress manual compaction ([#8920](https://github.com/earendil-works/pi/issues/8920)).
