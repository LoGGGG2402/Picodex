import { basename, isAbsolute, relative } from "node:path";

import type { SearchableWorkspaceFile } from "./shared.js";

export function buildSearchableWorkspacePath(options: {
  absolutePath: string;
  root: string;
  rootLabel: string;
  includeRootName: boolean;
}): string {
  const relativePath = relative(options.root, options.absolutePath);
  if (!options.includeRootName) {
    return relativePath;
  }

  return relativePath.length > 0 ? `${options.rootLabel}/${relativePath}` : options.rootLabel;
}

export function isPathInsideRoot(root: string, targetPath: string): boolean {
  const relativePath = relative(root, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function rankWorkspaceFiles(
  files: SearchableWorkspaceFile[],
  query: string,
  limit: number,
): string[] {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return files
      .slice()
      .sort((left, right) => left.searchablePath.localeCompare(right.searchablePath))
      .slice(0, limit)
      .map((file) => file.absolutePath);
  }

  return files
    .map((file) => ({
      file,
      score: scoreWorkspacePathMatch(file.searchablePath, trimmedQuery),
    }))
    .filter(
      (entry): entry is { file: SearchableWorkspaceFile; score: number } => entry.score !== null,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.file.searchablePath.length !== right.file.searchablePath.length) {
        return left.file.searchablePath.length - right.file.searchablePath.length;
      }
      return left.file.searchablePath.localeCompare(right.file.searchablePath);
    })
    .slice(0, limit)
    .map((entry) => entry.file.absolutePath);
}

export function looksLikeBinaryFile(contents: Buffer): boolean {
  const sampleSize = Math.min(contents.length, 8_192);
  let suspiciousByteCount = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    const byte = contents[index];
    if (byte === 0) {
      return true;
    }
    const isControlCharacter = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    if (isControlCharacter) {
      suspiciousByteCount += 1;
    }
  }

  return sampleSize > 0 && suspiciousByteCount / sampleSize > 0.1;
}

export function isWorkspacePreviewImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function scoreWorkspacePathMatch(path: string, query: string): number | null {
  const normalizedPath = path.toLowerCase();
  const normalizedBaseName = basename(path).toLowerCase();

  if (normalizedBaseName === query) {
    return 0;
  }
  if (normalizedBaseName.startsWith(query)) {
    return 10 + Math.max(0, normalizedBaseName.length - query.length);
  }
  if (normalizedBaseName.includes(query)) {
    return 30 + normalizedBaseName.indexOf(query);
  }
  if (normalizedPath.includes(query)) {
    return 100 + normalizedPath.indexOf(query);
  }

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let gaps = 0;
  let previousMatchIndex = -1;

  for (
    let pathIndex = 0;
    pathIndex < normalizedPath.length && queryIndex < query.length;
    pathIndex += 1
  ) {
    if (normalizedPath[pathIndex] !== query[queryIndex]) {
      continue;
    }
    if (firstMatchIndex === -1) {
      firstMatchIndex = pathIndex;
    }
    if (previousMatchIndex >= 0) {
      gaps += pathIndex - previousMatchIndex - 1;
    }
    previousMatchIndex = pathIndex;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) {
    return null;
  }

  return 500 + gaps + (firstMatchIndex === -1 ? 0 : firstMatchIndex);
}
