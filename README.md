# picodex

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

## Single-file launcher

Run `npm run build:single` to generate `dist/cli.js`.

That output is a self-extracting Node launcher. It embeds:

- the compiled `dist/` runtime
- the local `app.asar`
- the runtime `node_modules` subset needed to execute Picodex

At startup it extracts itself into the user cache directory and then launches Picodex with `--asar` pointed at the embedded `app.asar`. `codex` still needs to exist on `PATH`, or you can pass `--codex-bin /path/to/codex`.

## GitHub release automation

The repository now includes `.github/workflows/release.yml`.

It builds a single Linux release asset on `ubuntu-latest`.

The workflow runs automatically on every push to `main`. Each run bumps the patch version in `package.json`, creates a matching git tag like `v0.3.1`, and publishes the executable `cli.js` directly to the GitHub Release plus a matching `cli.js.sha256` file.
