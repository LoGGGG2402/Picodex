import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

import mimeTypes from "mime-types";

import {
  MAX_PREVIEW_FILE_BYTES,
  MAX_PREVIEW_MEDIA_BYTES,
  type FuzzyFileSearchSession,
  type HostBrowserEntry,
  type WorkspaceBrowserEntry,
  type WorkspaceBrowserRoot,
  type WorkspaceBrowserSearchResult,
} from "./shared.js";
import { stripFileExtension } from "./local-environment.js";
import { isJsonRecord, normalizeNonEmptyString, uniqueStrings } from "./utils.js";
import {
  resolveFuzzyFileSearchRoots,
  resolveWorkspaceBrowserRoots,
  resolveWorkspaceDirectoryRequest,
  searchWorkspaceFiles,
  type WorkspaceBrowserBridgeContext,
} from "./workspace-browser.js";
import { isPathInsideRoot, isWorkspacePreviewImageMimeType, looksLikeBinaryFile } from "./workspace.js";
import { highlightWorkspacePreviewCode } from "./workspace-preview-highlighter.js";

export interface FileBrowserContext extends WorkspaceBrowserBridgeContext {
  workspaceRootLabels: Map<string, string>;
  fuzzyFileSearchSessions: Map<string, FuzzyFileSearchSession>;
  emitBridgeMessage(message: { type: string; [key: string]: unknown }): void;
}

export async function resolveHostFiles(
  _bridge: FileBrowserContext,
  params: unknown,
): Promise<{
  files: Array<{
    label: string;
    path: string;
    fsPath: string;
  }>;
}> {
  const requestedPaths =
    isJsonRecord(params) && Array.isArray(params.paths) ? uniqueStrings(params.paths) : [];
  if (requestedPaths.length === 0) {
    throw new Error("At least one file path is required.");
  }

  const files = [];
  for (const rawPath of requestedPaths) {
    const resolvedPath = resolve(rawPath);
    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch {
      throw new Error(`File path does not exist: ${resolvedPath}`);
    }

    if (!stats.isFile()) {
      throw new Error(`File path is not a file: ${resolvedPath}`);
    }

    files.push({
      label: stripFileExtension(basename(resolvedPath)) || basename(resolvedPath) || "File",
      path: resolvedPath,
      fsPath: resolvedPath,
    });
  }

  return { files };
}

export async function listHostDirectory(
  _bridge: FileBrowserContext,
  params: unknown,
): Promise<{ path: string; entries: HostBrowserEntry[] }> {
  const requestedPath =
    isJsonRecord(params) && typeof params.path === "string" ? params.path.trim() : "";
  const resolvedPath = resolve(requestedPath || homedir());
  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch {
    throw new Error(`Directory does not exist: ${resolvedPath}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }

  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const items = entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      path: join(resolvedPath, entry.name),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null,
    }))
    .filter((entry): entry is HostBrowserEntry => entry.kind !== null)
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    path: resolvedPath,
    entries: items,
  };
}

export async function handleFuzzyFileSearch(
  bridge: FileBrowserContext,
  params: unknown,
): Promise<{ files: string[] }> {
  const query = isJsonRecord(params) && typeof params.query === "string" ? params.query : "";
  const roots = await resolveFuzzyFileSearchRoots(bridge, isJsonRecord(params) ? params.roots : undefined);
  return { files: await searchWorkspaceFiles(roots, query) };
}

export async function listWorkspaceFileRoots(
  bridge: FileBrowserContext,
): Promise<{ roots: WorkspaceBrowserRoot[] }> {
  const roots = await resolveWorkspaceBrowserRoots(bridge);
  const activeRoot = roots[0] ?? null;
  return {
    roots: roots.map((root) => ({
      path: root,
      label: bridge.workspaceRootLabels.get(root) ?? (basename(root) || "Workspace"),
      active: root === activeRoot,
    })),
  };
}

export async function listWorkspaceDirectory(
  bridge: FileBrowserContext,
  params: unknown,
): Promise<{
  root: string;
  path: string;
  relativePath: string;
  entries: WorkspaceBrowserEntry[];
}> {
  const { root, path } = await resolveWorkspaceDirectoryRequest(bridge, params);
  const entries = await readdir(path, { withFileTypes: true });
  const items = entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      path: join(path, entry.name),
      relativePath: relative(root, join(path, entry.name)),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null,
    }))
    .filter((entry): entry is WorkspaceBrowserEntry => entry.kind !== null)
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    root,
    path,
    relativePath: relative(root, path) || ".",
    entries: items,
  };
}

export async function readWorkspaceFile(
  bridge: FileBrowserContext,
  params: unknown,
): Promise<{
  root: string;
  path: string;
  relativePath: string;
  kind: "text" | "image" | "pdf" | "binary";
  mimeType: string;
  size: number;
  contents?: string;
  contentsBase64?: string;
}> {
  const filePath =
    isJsonRecord(params) && typeof params.path === "string" ? params.path.trim() : "";
  if (!filePath) {
    throw new Error("Workspace file path is required.");
  }

  const roots = await resolveWorkspaceBrowserRoots(bridge);
  const resolvedPath = resolve(filePath);
  const root = roots.find((candidate) => isPathInsideRoot(candidate, resolvedPath));
  if (!root) {
    throw new Error(`Workspace file is outside active roots: ${resolvedPath}`);
  }

  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch {
    throw new Error(`File path does not exist: ${resolvedPath}`);
  }

  if (!stats.isFile()) {
    throw new Error(`File path is not a file: ${resolvedPath}`);
  }

  const detectedMimeType = mimeTypes.lookup(resolvedPath) || "application/octet-stream";
  const isImage = isWorkspacePreviewImageMimeType(detectedMimeType);
  const isPdf = detectedMimeType === "application/pdf";
  const maxPreviewBytes = isImage || isPdf ? MAX_PREVIEW_MEDIA_BYTES : MAX_PREVIEW_FILE_BYTES;
  if (stats.size > maxPreviewBytes) {
    throw new Error(`File is too large to preview: ${resolvedPath}`);
  }

  const contents = await readFile(resolvedPath);

  if (isImage) {
    return {
      root,
      path: resolvedPath,
      relativePath: relative(root, resolvedPath),
      kind: "image",
      mimeType: detectedMimeType,
      size: stats.size,
      contentsBase64: contents.toString("base64"),
    };
  }

  if (isPdf) {
    return {
      root,
      path: resolvedPath,
      relativePath: relative(root, resolvedPath),
      kind: "pdf",
      mimeType: detectedMimeType,
      size: stats.size,
      contentsBase64: contents.toString("base64"),
    };
  }

  if (looksLikeBinaryFile(contents)) {
    return {
      root,
      path: resolvedPath,
      relativePath: relative(root, resolvedPath),
      kind: "binary",
      mimeType: detectedMimeType,
      size: stats.size,
    };
  }

  return {
    root,
    path: resolvedPath,
    relativePath: relative(root, resolvedPath),
    kind: "text",
    mimeType: "text/plain",
    size: stats.size,
    contents: contents.toString("utf8"),
  };
}

export async function highlightWorkspaceFile(
  _bridge: FileBrowserContext,
  params: unknown,
): Promise<{ html: string; language: string }> {
  const contents =
    isJsonRecord(params) && typeof params.contents === "string" ? params.contents : "";
  if (!contents) {
    return { html: "", language: "" };
  }

  const language =
    isJsonRecord(params) && typeof params.language === "string" ? params.language : "";
  const themeVariant =
    isJsonRecord(params) && typeof params.themeVariant === "string" ? params.themeVariant : "";

  return highlightWorkspacePreviewCode({
    code: contents,
    language,
    themeVariant,
  });
}

export async function resolveWorkspaceFileDownload(
  bridge: FileBrowserContext,
  filePath: string,
): Promise<{
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
}> {
  const requestedPath = filePath.trim();
  if (!requestedPath) {
    throw new Error("Workspace file path is required.");
  }

  const roots = await resolveWorkspaceBrowserRoots(bridge);
  const resolvedPath = resolve(requestedPath);
  const root = roots.find((candidate) => isPathInsideRoot(candidate, resolvedPath));
  if (!root) {
    throw new Error(`Workspace file is outside active roots: ${resolvedPath}`);
  }

  const fileStats = await stat(resolvedPath).catch(() => {
    throw new Error(`File path does not exist: ${resolvedPath}`);
  });
  if (!fileStats.isFile()) {
    throw new Error(`File path is not a file: ${resolvedPath}`);
  }

  return {
    path: resolvedPath,
    fileName: basename(resolvedPath),
    mimeType: mimeTypes.lookup(resolvedPath) || "application/octet-stream",
    size: fileStats.size,
  };
}

export async function searchWorkspaceBrowserFiles(
  bridge: FileBrowserContext,
  params: unknown,
): Promise<{ query: string; files: WorkspaceBrowserSearchResult[] }> {
  const query = isJsonRecord(params) && typeof params.query === "string" ? params.query : "";
  const roots = await resolveWorkspaceBrowserRoots(bridge);
  const requestedRoot =
    isJsonRecord(params) && typeof params.root === "string" ? resolve(params.root) : "";
  const searchRoots = requestedRoot ? roots.filter((root) => root === requestedRoot) : roots;

  if (requestedRoot && searchRoots.length === 0) {
    throw new Error("Workspace root is not available.");
  }

  const files = await searchWorkspaceFiles(searchRoots, query);
  return {
    query,
    files: files.flatMap((filePath) => {
      const root = searchRoots.find((candidate) => isPathInsideRoot(candidate, filePath));
      if (!root) {
        return [];
      }
      return [{ root, path: filePath, relativePath: relative(root, filePath) }];
    }),
  };
}

export async function startFuzzyFileSearchSession(
  bridge: FileBrowserContext,
  params: unknown,
): Promise<{ sessionId: string; roots: string[] }> {
  const sessionId =
    isJsonRecord(params) && typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("Fuzzy file search session ID is required.");
  }

  const roots = await resolveFuzzyFileSearchRoots(bridge, isJsonRecord(params) ? params.roots : undefined);
  bridge.fuzzyFileSearchSessions.set(sessionId, {
    roots,
    query: "",
    revision: 0,
  });

  return { sessionId, roots };
}

export async function updateFuzzyFileSearchSession(
  bridge: FileBrowserContext,
  params: unknown,
): Promise<{ sessionId: string; query: string; files: string[] }> {
  const sessionId =
    isJsonRecord(params) && typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("Fuzzy file search session ID is required.");
  }

  const session = bridge.fuzzyFileSearchSessions.get(sessionId);
  if (!session) {
    throw new Error("Fuzzy file search session not found.");
  }

  session.query = isJsonRecord(params) && typeof params.query === "string" ? params.query : "";
  session.revision += 1;
  const revision = session.revision;
  const files = await searchWorkspaceFiles(session.roots, session.query);
  const latestSession = bridge.fuzzyFileSearchSessions.get(sessionId);
  if (!latestSession || latestSession.revision !== revision) {
    return { sessionId, query: session.query, files: [] };
  }

  bridge.emitBridgeMessage({
    type: "fuzzyFileSearch/sessionUpdated",
    params: { sessionId, query: session.query, files },
  });
  bridge.emitBridgeMessage({
    type: "fuzzyFileSearch/sessionCompleted",
    params: { sessionId, query: session.query },
  });

  return { sessionId, query: session.query, files };
}

export async function stopFuzzyFileSearchSession(
  bridge: FileBrowserContext,
  params: unknown,
): Promise<{ sessionId: string; stopped: boolean }> {
  const sessionId =
    isJsonRecord(params) && typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("Fuzzy file search session ID is required.");
  }

  return {
    sessionId,
    stopped: bridge.fuzzyFileSearchSessions.delete(sessionId),
  };
}
