import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { debugLog } from "../core/debug.js";
import {
  IGNORED_FILE_SEARCH_DIRECTORIES,
  MAX_FUZZY_FILE_CANDIDATES,
  MAX_FUZZY_FILE_RESULTS,
  type SearchableWorkspaceFile,
} from "./shared.js";
import { execFileText, isJsonRecord, normalizeError, uniqueStrings } from "./utils.js";
import {
  buildSearchableWorkspacePath,
  isPathInsideRoot,
  rankWorkspaceFiles,
} from "./workspace.js";

export interface WorkspaceBrowserBridgeContext {
  cwd: string;
  getActiveWorkspaceRoots(): string[];
}

export async function resolveFuzzyFileSearchRoots(
  bridge: WorkspaceBrowserBridgeContext,
  rawRoots: unknown,
): Promise<string[]> {
  const requestedRoots = Array.isArray(rawRoots) ? uniqueStrings(rawRoots) : [];
  const candidateRoots =
    requestedRoots.length > 0 ? requestedRoots : bridge.getActiveWorkspaceRoots();
  const roots = candidateRoots.length > 0 ? candidateRoots : [bridge.cwd];
  const resolvedRoots: string[] = [];

  for (const root of roots) {
    const resolvedRoot = resolve(root);
    let stats;
    try {
      stats = await stat(resolvedRoot);
    } catch {
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    resolvedRoots.push(resolvedRoot);
  }

  if (resolvedRoots.length === 0) {
    throw new Error("No workspace roots are available for file search.");
  }

  return uniqueStrings(resolvedRoots);
}

export async function resolveWorkspaceBrowserRoots(
  bridge: WorkspaceBrowserBridgeContext,
): Promise<string[]> {
  const candidateRoots = bridge.getActiveWorkspaceRoots();
  const roots = candidateRoots.length > 0 ? candidateRoots : [bridge.cwd];
  const resolvedRoots: string[] = [];

  for (const root of roots) {
    const resolvedRoot = resolve(root);
    let stats;
    try {
      stats = await stat(resolvedRoot);
    } catch {
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    resolvedRoots.push(resolvedRoot);
  }

  if (resolvedRoots.length === 0) {
    throw new Error("No workspace roots are available.");
  }

  return uniqueStrings(resolvedRoots);
}

export async function resolveWorkspaceDirectoryRequest(
  bridge: WorkspaceBrowserBridgeContext,
  params: unknown,
): Promise<{
  root: string;
  path: string;
}> {
  const roots = await resolveWorkspaceBrowserRoots(bridge);
  const requestedRoot =
    isJsonRecord(params) && typeof params.root === "string" ? params.root.trim() : "";
  const requestedPath =
    isJsonRecord(params) && typeof params.path === "string" ? params.path.trim() : "";
  const root = requestedRoot ? resolve(requestedRoot) : roots[0];

  if (!root || !roots.includes(root)) {
    throw new Error("Workspace root is not available.");
  }

  const path = requestedPath ? resolve(requestedPath) : root;
  if (!isPathInsideRoot(root, path)) {
    throw new Error(`Workspace directory is outside root: ${path}`);
  }

  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new Error(`Workspace directory does not exist: ${path}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${path}`);
  }

  return { root, path };
}

export async function searchWorkspaceFiles(
  roots: string[],
  query: string,
): Promise<string[]> {
  const candidates = await listWorkspaceFiles(roots);
  return rankWorkspaceFiles(candidates, query, MAX_FUZZY_FILE_RESULTS);
}

export async function listWorkspaceFiles(
  roots: string[],
): Promise<SearchableWorkspaceFile[]> {
  const ripgrepFiles = await listWorkspaceFilesWithRipgrep(roots);
  if (ripgrepFiles) {
    return ripgrepFiles;
  }

  return listWorkspaceFilesWithDirectoryWalk(roots);
}

export async function listWorkspaceFilesWithRipgrep(
  roots: string[],
): Promise<SearchableWorkspaceFile[] | null> {
  try {
    const files: SearchableWorkspaceFile[] = [];
    const seen = new Set<string>();
    const includeRootName = roots.length > 1;

    for (const root of roots) {
      const stdout = await execFileText(
        "rg",
        [
          "--files",
          "--hidden",
          "--glob",
          "!.git",
          "--glob",
          "!node_modules",
          "--glob",
          "!dist",
          "--glob",
          "!coverage",
          ".",
        ],
        root,
      );

      const rootLabel = basename(root);
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === ".") {
          continue;
        }

        const absolutePath = resolve(root, trimmed);
        if (seen.has(absolutePath)) {
          continue;
        }

        seen.add(absolutePath);
        files.push({
          absolutePath,
          searchablePath: buildSearchableWorkspacePath({
            absolutePath,
            root,
            rootLabel,
            includeRootName,
          }),
        });
        if (files.length >= MAX_FUZZY_FILE_CANDIDATES) {
          return files;
        }
      }
    }

    return files;
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.message.includes("ENOENT")) {
      return null;
    }
    debugLog("app-server", "ripgrep file search failed, falling back to directory walk", {
      error: normalized.message,
    });
    return null;
  }
}

export async function listWorkspaceFilesWithDirectoryWalk(
  roots: string[],
): Promise<SearchableWorkspaceFile[]> {
  const files: SearchableWorkspaceFile[] = [];
  const seen = new Set<string>();
  const includeRootName = roots.length > 1;

  for (const root of roots) {
    const rootLabel = basename(root);
    const queue = [root];

    while (queue.length > 0) {
      const currentDirectory = queue.shift();
      if (!currentDirectory) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(currentDirectory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absolutePath = join(currentDirectory, entry.name);

        if (entry.isSymbolicLink()) {
          continue;
        }

        if (entry.isDirectory()) {
          if (IGNORED_FILE_SEARCH_DIRECTORIES.has(entry.name)) {
            continue;
          }
          queue.push(absolutePath);
          continue;
        }

        if (!entry.isFile() || seen.has(absolutePath)) {
          continue;
        }

        seen.add(absolutePath);
        files.push({
          absolutePath,
          searchablePath: buildSearchableWorkspacePath({
            absolutePath,
            root,
            rootLabel,
            includeRootName,
          }),
        });
        if (files.length >= MAX_FUZZY_FILE_CANDIDATES) {
          return files;
        }
      }
    }
  }

  return files;
}
