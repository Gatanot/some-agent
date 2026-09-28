# Changelog

## [Unreleased]

### Added

- Added compact `web_search` and cleaned `web_fetch` tool factories with provider injection and argument-only call history.

## [0.1.9] - 2026-09-07

### Fixed

- Fixed proxied assistant responses dropping persisted provider-native thinking levels.
- Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count ([#8979](https://github.com/earendil-works/pi/issues/8979)).
