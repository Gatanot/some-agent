# Orrery Web

Orrery Web is the local Svelte + Vite workbench UI. It connects to the current local agent session through the server-side API and SSE stream; the browser does not contain a second agent or a separate demo state.

## Run

From the repository root during development:

```bash
npm run web
```

For the installed Orrery CLI:

```bash
orrery web
orrery web --port 3210 --cwd /path/to/project
```

Open `http://127.0.0.1:3210`. The development server uses Vite middleware for the Svelte UI and keeps the agent API on the same loopback port. The published `orrery web` command serves the bundled production assets. If the requested port is already in use, the server tries the next ports (up to 20) and prints the address it bound.

Useful environment variables:

- `PI_WEB_PORT`: HTTP port, default `3210`.
- `PI_WEB_CWD`: agent working directory, default repository root.
- `PI_WEB_MODE=production`: serve the previously built `dist` assets instead of Vite middleware.

The page renders only the current session returned by the server. The transcript, streaming assistant message, pending tool calls, tool partial/result state, and session title come from the live snapshot. The Changes panel shows the repository's current working-tree status (including pre-existing changes, not only changes made by the agent). The server reads it on session open and after each prompt finishes; the refresh button reads it again on demand. Non-Git directories and Git errors have distinct states. The command log shows actual shell tool invocations from the selected session with output collapsed by default, while session information shows the full directory, session ID, model, thinking level, and recent usage. A vertical activity bar on the right selects one panel at a time (Sessions, Changes with a changed-file badge, Usage, and Settings); its top plus button starts a new session, clicking the active icon closes the panel, and the open panel and its dragged width are persisted locally. Panels push the timeline on wide layouts and can be resized by dragging the divider between the timeline and the panel (220-560 px); below 820 px they overlay the timeline with a backdrop. The Sessions panel has no header, so search and history reach the top. The workspace button at the bottom of the activity bar opens a picker dialog: recent directories come from `/api/workspaces`, the directory browser reads subdirectories from `/api/workspace/browse` (with an editable absolute path), choosing a directory calls `/api/workspace/select`, and switching is rejected while the agent is busy. Each browser tab creates its own workspace with `POST /api/workspaces` and sends the returned id in the `x-orrery-workspace` header (or the `workspace` query parameter for the SSE stream), so tabs keep separate sessions, working directories, and recent lists. Requests without an id use the default workspace. The Sessions panel loads real history from `/api/sessions`; selecting a session calls `/api/session/select`, switching is rejected while a prompt is running, and renaming calls `/api/session/name`. Drafts are kept in browser memory per session id and are restored when switching sessions. Typing `@` in the composer opens project file suggestions from `/api/files` (Git-tracked and untracked files, with a directory-walk fallback outside Git repos); choosing one inserts `@path` and the agent reads the file itself. The Settings panel (activity bar gear icon, or the configure action on the no-model notice) reads and writes the active session's `SettingsManager` through `/api/settings`: default model, default thinking level, per-model thinking overrides, per-model context window overrides, automatic compaction with reserve/keep-recent tokens, queueing modes, and retry. Model choices come from the authenticated models exposed by the active `ModelRuntime` and are changed through `/api/session/model`; thinking levels are limited to the active model's supported levels through `/api/session/thinking`. The settings model section lists every provider with its auth and catalog status from `/api/providers`, fetches one provider at a time through `/api/models/refresh` with a `provider` id, lists models from `/api/models`, enables or disables them through the persisted `enabledModels` setting, and stores per-model context windows in the `modelContextWindows` setting. Providers configured only in `models.json` with an OpenAI-compatible API are discovered from their `/models` endpoint. The provider configuration section adds and removes `models.json` providers through `/api/providers/config` (provider ID, API type, base URL, API key, and model IDs), then reloads the active `ModelRuntime` from disk; API keys are never returned to the browser. User and assistant text use Markdown with raw HTML escaped, unsafe link schemes disabled, and code blocks escaped as text. Before the first snapshot it shows only a connection state; it does not fill the page with sample conversations. No model configuration is required to start the web server, but prompting requires a usable model. The light and dark palettes share one semantic token set; the theme button at the bottom of the activity bar switches between them, the initial theme follows the system preference, and an explicit choice is stored locally.

The server keeps agent credentials on the server, binds only to loopback, validates the request host/origin, limits JSON request bodies to 64 KiB, and sends SSE heartbeats. Tests inject an in-memory `AgentSession` backed by a faux provider through the same HTTP/SSE path, covering streamed messages, tool partials and failures, cancellation, reconnect snapshots, model/thinking selection, and session transition conflicts. Chromium smoke coverage includes rename, Markdown escaping, code copy, and desktop/narrow layouts. Branch management and syntax highlighting remain later work.

## Build

```bash
npm --prefix packages/web exec vite build
```

The generated `dist` directory is a local build artifact and is not required for development mode.
