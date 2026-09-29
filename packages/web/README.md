# Orrery Web

Orrery Web is the local Svelte + Vite workbench UI. It connects to the current local agent session through the server-side API and SSE stream; the browser does not contain a second agent or a separate demo state.

## Run

From the repository root:

```bash
npm run web
```

Open `http://127.0.0.1:3210`. The development server uses Vite middleware for the Svelte UI and keeps the agent API on the same loopback port.

Useful environment variables:

- `PI_WEB_PORT`: HTTP port, default `3210`.
- `PI_WEB_CWD`: agent working directory, default repository root.
- `PI_WEB_MODE=production`: serve the previously built `dist` assets instead of Vite middleware.

The page renders only the current session returned by the server. The transcript, streaming assistant message, pending tool calls, tool partial/result state, and session title come from the live snapshot. The right-hand Git tab shows the repository's current working-tree status (including pre-existing changes, not only changes made by the agent). The server reads it on session open and after each prompt finishes; the refresh button reads it again on demand. Non-Git directories and Git errors have distinct states. The command log shows actual shell tool invocations from the selected session with output collapsed by default, while session information shows the full directory, session ID, model, thinking level, and recent usage. The session sidebar toggles between a fixed panel and a single expand control. It loads real history from `/api/sessions`; selecting a session calls `/api/session/select`, switching is rejected while a prompt is running, and renaming calls `/api/session/name`. Drafts are kept in browser memory per session id and are restored when switching sessions. Typing `@` in the composer opens project file suggestions from `/api/files` (Git-tracked and untracked files, with a directory-walk fallback outside Git repos); choosing one inserts `@path` and the agent reads the file itself. A settings panel (topbar gear button, or the configure action on the no-model notice) reads and writes the active session's `SettingsManager` through `/api/settings`: default model, default thinking level, per-model thinking overrides, automatic compaction with reserve/keep-recent tokens, queueing modes, and retry. Model choices come from the authenticated models exposed by the active `ModelRuntime` and are changed through `/api/session/model`; thinking levels are limited to the active model's supported levels through `/api/session/thinking`. User and assistant text use Markdown with raw HTML escaped, unsafe link schemes disabled, and code blocks escaped as text. Before the first snapshot it shows only a connection state; it does not fill the page with sample conversations. No model configuration is required to start the web server, but prompting requires a usable model. The light and dark palettes share one semantic token set; the topbar theme button switches between them, the initial theme follows the system preference, and an explicit choice is stored locally.

The server keeps agent credentials on the server, binds only to loopback, validates the request host/origin, limits JSON request bodies to 64 KiB, and sends SSE heartbeats. Tests inject an in-memory `AgentSession` backed by a faux provider through the same HTTP/SSE path, covering streamed messages, tool partials and failures, cancellation, reconnect snapshots, model/thinking selection, and session transition conflicts. Chromium smoke coverage includes rename, Markdown escaping, code copy, and desktop/narrow layouts. Branch management and syntax highlighting remain later work.

## Build

```bash
npm --prefix packages/web exec vite build
```

The generated `dist` directory is a local build artifact and is not required for development mode.
