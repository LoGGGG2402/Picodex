#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { AppServerBridge } from "./bridge/index.js";
import { loadCodexBundle } from "./desktop/codex-bundle.js";
import { deriveDefaultAppPath, resolveCodexDesktopPaths } from "./desktop/codex-installation.js";
import { renderBootstrapScript } from "./browser/bootstrap/index.js";
import { patchIndexHtml } from "./server/html-patcher.js";
import type { SentryInitOptions, ServeCommandOptions } from "./core/protocol.js";
import { getServeUrls } from "./server/serve-url.js";
import { PicodexServer } from "./server/picodex-server.js";

const DEFAULT_LISTEN = "127.0.0.1:8787";
const POCODEX_STYLESHEET_HREF = "/picodex.css";
const FLAG_NAMES_WITH_VALUES = new Set(["--app", "--asar", "--codex-bin", "--listen", "--token"]);
const BOOLEAN_FLAG_NAMES = new Set(["--dev"]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command && command !== "serve" && !command.startsWith("--")) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const serveArgv = command === "serve" ? argv.slice(1) : argv;
  if (serveArgv.includes("help") || serveArgv.includes("--help") || serveArgv.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseServeCommand(serveArgv);
  const resolvedCodexPaths = await resolveCodexDesktopPaths({
    appPath: options.appPath,
    appAsarPath: options.appAsarPath,
    codexCliPath: options.codexCliPath,
  });
  const picodexCssPath = fileURLToPath(new URL("./assets/styles/picodex.css", import.meta.url));
  const importIconSvgPath = fileURLToPath(new URL("./assets/images/import.svg", import.meta.url));
  const bundle = await loadCodexBundle(resolvedCodexPaths);
  const relay = await AppServerBridge.connect({
    appPath: resolvedCodexPaths.appPath,
    appAsarPath: resolvedCodexPaths.appAsarPath,
    codexCliPath: resolvedCodexPaths.codexCliPath,
    cwd: process.cwd(),
  });

  const sentryOptions: SentryInitOptions = {
    buildFlavor: bundle.buildFlavor,
    appVersion: bundle.version,
    buildNumber: bundle.buildNumber,
    codexAppSessionId: randomUUID(),
  };

  const server = new PicodexServer({
    listenHost: options.listenHost,
    listenPort: options.listenPort,
    token: options.token,
    relay,
    webviewRoot: bundle.webviewRoot,
    readPicodexStylesheet: async () => readFile(picodexCssPath, "utf8"),
    renderIndexHtml: async () => {
      const indexHtml = await bundle.readIndexHtml();
      return patchIndexHtml(indexHtml, {
        bootstrapScript: renderBootstrapScript({
          sentryOptions,
          stylesheetHref: POCODEX_STYLESHEET_HREF,
          importIconSvg: await readFile(importIconSvgPath, "utf8"),
        }),
        stylesheetHref: POCODEX_STYLESHEET_HREF,
      });
    },
  });

  const stopWatchingStylesheet = options.devMode
    ? watchPicodexStylesheet(picodexCssPath, () => {
        server.notifyStylesheetReload(String(Date.now()));
      })
    : () => {};

  const shutdown = async (signal: string) => {
    console.log(`\nShutting down Picodex after ${signal}...`);
    stopWatchingStylesheet();
    await server.close();
    await relay.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await server.listen();
  const listeningAddress = server.getAddress();
  const serveUrls = getServeUrls({
    listenHost: options.listenHost,
    listenPort: listeningAddress.port,
    token: options.token,
  });

  console.log(`Picodex listening on ${serveUrls.localUrl}`);
  console.log(`Open ${serveUrls.localOpenUrl}`);
  if (serveUrls.networkUrl && serveUrls.networkOpenUrl) {
    console.log(`Local network URL ${serveUrls.networkUrl}`);
    console.log(`Open on your local network ${serveUrls.networkOpenUrl}`);
  } else if (options.listenHost === "0.0.0.0") {
    console.log("Local network URL unavailable; no active LAN IPv4 address was detected.");
  } else if (options.listenHost === "127.0.0.1" || options.listenHost === "localhost") {
    console.log(
      `Local network URL unavailable while listening on ${serveUrls.localUrl} (use --listen 0.0.0.0:${listeningAddress.port} to expose it on your LAN)`,
    );
  }
  console.log(`Using Codex ${bundle.version} from ${bundle.appPath}`);
  console.log(`Using direct app-server bridge from ${resolvedCodexPaths.codexCliPath}`);
  if (options.devMode) {
    console.log(`Watching ${picodexCssPath} for stylesheet changes`);
  }
}

function parseServeCommand(argv: string[]): ServeCommandOptions {
  validateServeArgs(argv);

  const requestedAppPath = readFlag(argv, "--app");
  const appAsarPath = readFlag(argv, "--asar");
  const codexCliPath = readFlag(argv, "--codex-bin");
  const listen = readFlag(argv, "--listen") ?? DEFAULT_LISTEN;
  const token = readFlag(argv, "--token") ?? "";
  const devMode = hasFlag(argv, "--dev");

  const [listenHost, portText] = listen.split(":");
  const listenPort = Number.parseInt(portText ?? "", 10);
  if (!listenHost || !Number.isInteger(listenPort) || listenPort <= 0) {
    throw new Error(`Invalid --listen value: ${listen}`);
  }

  return {
    appPath: requestedAppPath ?? deriveDefaultAppPath({ appAsarPath, codexCliPath }) ?? process.cwd(),
    appAsarPath,
    codexCliPath,
    devMode,
    listenHost,
    listenPort,
    token,
  };
}

function validateServeArgs(argv: string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("-")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    if (BOOLEAN_FLAG_NAMES.has(arg)) {
      continue;
    }

    if (FLAG_NAMES_WITH_VALUES.has(arg)) {
      index += 1;
      const value = argv[index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function printUsage(): void {
  console.error("Usage:");
  console.error(
    "  picodex [--token <secret>] [--asar /path/to/app.asar] [--app /path/to/Codex] [--codex-bin /path/to/codex] [--listen 127.0.0.1:8787] [--dev]",
  );
}

function watchPicodexStylesheet(cssFilePath: string, onChange: () => void): () => void {
  const cssDirectory = dirname(cssFilePath);
  const cssFilename = basename(cssFilePath);
  let debounceTimer: NodeJS.Timeout | undefined;

  const watcher = watch(cssDirectory, (_eventType, changedFilename) => {
    const changedName = changedFilename ? String(changedFilename) : undefined;
    if (changedName && changedName !== cssFilename) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      onChange();
    }, 50);
  });

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}

await main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
