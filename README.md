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

## Single-file launcher

Run `npm run build:single` to generate `dist/pocodex-single.js`.

That output is a self-extracting Node launcher. It embeds:

- the compiled `dist/` runtime
- the local `app.asar`
- the runtime `node_modules` subset needed to execute Pocodex

At startup it extracts itself into the user cache directory and then launches Pocodex with `--asar` pointed at the embedded `app.asar`. `codex` still needs to exist on `PATH`, or you can pass `--codex-bin /path/to/codex`.

## GitHub release automation

The repository now includes `.github/workflows/release.yml`.

It builds release assets for:

- `linux-x64` on `ubuntu-latest`
- `darwin-x64` on `macos-13`
- `darwin-arm64` on `macos-14`

The workflow runs automatically when you push a tag like `v0.3.0`, and it can also be started manually with `workflow_dispatch`. Each run publishes GitHub Release assets named like `pocodex-v0.3.0-darwin-arm64.js` plus matching `.sha256` files.
The release job also marks the `.js` launcher executable with `chmod +x` and publishes a `.zip` copy with its own checksum.
