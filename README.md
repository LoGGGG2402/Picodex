# pocodex

Browser-hosted wrapper around the Codex desktop webview with a direct app-server bridge.

## Source layout

- `src/cli.ts`: CLI entrypoint.
- `src/assets/`: static assets copied into `dist/`.
- `src/bridge/`: host bridge logic that talks to the Codex app-server runtime.
- `src/browser/`: browser bootstrap code injected into the webview.
- `src/core/`: shared protocol, request-id, and debug utilities.
- `src/desktop/`: Codex desktop bundle and installation discovery helpers.
- `src/server/`: HTTP/WebSocket serving layer.
- `src/state/`: persisted local registries under `CODEX_HOME`.
- `src/terminal/`: PTY session management.
