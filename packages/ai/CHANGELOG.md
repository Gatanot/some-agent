# Changelog

## [Unreleased]

### Added

- Added Anthropic per-turn effort persistence, deterministic historical effort markers, and signed-thinking mismatch recovery for supported Claude models across Anthropic Messages transports, including OpenRouter.

### Fixed

- Fixed GitHub Copilot Claude Fable 5 requests to use the Anthropic Messages adapter so selected reasoning levels are sent ([#8961](https://github.com/earendil-works/pi/issues/8961)).
