import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";

export interface ResolveCodexDesktopOptions {
  appPath: string;
  appAsarPath?: string;
  codexCliPath?: string;
}

export interface ResolvedCodexDesktopPaths {
  appPath: string;
  appAsarPath: string;
  codexCliPath: string;
  infoPlistPath?: string;
}

export async function resolveCodexDesktopPaths(
  options: ResolveCodexDesktopOptions,
): Promise<ResolvedCodexDesktopPaths> {
  const resolvedAppPath = resolve(options.appPath);
  const rootCandidates = collectRootCandidates(
    resolvedAppPath,
    options.appAsarPath ? resolve(options.appAsarPath) : undefined,
    options.codexCliPath ? resolve(options.codexCliPath) : undefined,
  );

  const appAsarPath = await firstExistingPath([
    ...(options.appAsarPath ? [resolve(options.appAsarPath)] : []),
    ...rootCandidates.flatMap((rootPath) => [
      join(rootPath, "app.asar"),
      join(rootPath, "Contents", "Resources", "app.asar"),
      join(rootPath, "resources", "app.asar"),
    ]),
  ]);
  if (!appAsarPath) {
    throw new Error(
      [
        `Codex app.asar could not be found for ${resolvedAppPath}.`,
        "Pass --app to a Codex app root, or pass --asar with the exact app.asar path.",
      ].join(" "),
    );
  }

  const codexCliPath = options.codexCliPath
    ? resolve(options.codexCliPath)
    : await findExecutableInPath("codex");
  if (!codexCliPath) {
    throw new Error(
      [
        `Codex CLI binary could not be found for ${resolvedAppPath}.`,
        "Install codex on PATH or pass --codex-bin with the exact codex binary path.",
      ].join(" "),
    );
  }

  const appPath = deriveCanonicalAppPath(resolvedAppPath, appAsarPath, codexCliPath);
  const infoPlistCandidate = join(appPath, "Contents", "Info.plist");
  const infoPlistPath = (await pathExists(infoPlistCandidate)) ? infoPlistCandidate : undefined;

  return {
    appPath,
    appAsarPath,
    codexCliPath,
    infoPlistPath,
  };
}

export function deriveDefaultAppPath(
  overrides: Pick<ResolveCodexDesktopOptions, "appAsarPath" | "codexCliPath">,
): string | undefined {
  if (overrides.appAsarPath) {
    const resolvedAsarPath = resolve(overrides.appAsarPath);
    return deriveCanonicalAppPath(resolvedAsarPath, resolvedAsarPath, undefined);
  }

  if (overrides.codexCliPath) {
    const resolvedCliPath = resolve(overrides.codexCliPath);
    return deriveCanonicalAppPath(resolvedCliPath, undefined, resolvedCliPath);
  }

  return undefined;
}

function collectRootCandidates(
  appPath: string,
  appAsarPath?: string,
  codexCliPath?: string,
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  const add = (candidate: string | undefined) => {
    if (!candidate) {
      return;
    }
    const resolvedCandidate = resolve(candidate);
    if (seen.has(resolvedCandidate)) {
      return;
    }
    seen.add(resolvedCandidate);
    candidates.push(resolvedCandidate);
  };

  for (const inputPath of [appPath, appAsarPath, codexCliPath]) {
    if (!inputPath) {
      continue;
    }

    const resolvedInputPath = resolve(inputPath);
    const inputName = basename(resolvedInputPath);
    if (inputName === "app.asar") {
      add(dirname(resolvedInputPath));
      add(dirname(dirname(resolvedInputPath)));
      add(dirname(dirname(dirname(resolvedInputPath))));
      continue;
    }

    if (inputName === "codex") {
      add(dirname(resolvedInputPath));
      add(dirname(dirname(resolvedInputPath)));
      add(dirname(dirname(dirname(resolvedInputPath))));
      continue;
    }

    add(resolvedInputPath);
  }

  return candidates;
}

function deriveCanonicalAppPath(
  appPath: string,
  appAsarPath?: string,
  codexCliPath?: string,
): string {
  const resolvedAppPath = resolve(appPath);
  const resolvedAppAsarPath = appAsarPath ? resolve(appAsarPath) : undefined;
  const resolvedCliPath = codexCliPath ? resolve(codexCliPath) : undefined;

  if (resolvedAppAsarPath?.endsWith("/Contents/Resources/app.asar")) {
    return dirname(dirname(dirname(resolvedAppAsarPath)));
  }
  if (resolvedAppAsarPath?.endsWith("/resources/app.asar")) {
    return dirname(dirname(resolvedAppAsarPath));
  }
  if (basename(resolvedAppAsarPath ?? "") === "app.asar") {
    return dirname(resolvedAppAsarPath as string);
  }
  if (resolvedCliPath?.endsWith("/Contents/Resources/codex")) {
    return dirname(dirname(dirname(resolvedCliPath)));
  }
  if (resolvedCliPath?.endsWith("/bin/codex") || resolvedCliPath?.endsWith("/resources/codex")) {
    return dirname(dirname(resolvedCliPath));
  }
  if (basename(resolvedCliPath ?? "") === "codex") {
    return dirname(resolvedCliPath as string);
  }
  if (basename(resolvedAppPath) === "app.asar") {
    return deriveCanonicalAppPath(dirname(resolvedAppPath), resolvedAppPath, undefined);
  }
  if (basename(resolvedAppPath) === "codex") {
    return deriveCanonicalAppPath(dirname(resolvedAppPath), undefined, resolvedAppPath);
  }

  return resolvedAppPath;
}

async function firstExistingPath(candidates: string[]): Promise<string | undefined> {
  const dedupedCandidates = [...new Set(candidates.map((candidate) => resolve(candidate)))];
  for (const candidate of dedupedCandidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findExecutableInPath(name: string): Promise<string | undefined> {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  for (const pathSegment of pathValue.split(delimiter)) {
    const candidate = resolve(pathSegment || ".", name);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const file = await stat(path);
    if (!file.isFile()) {
      return false;
    }

    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
