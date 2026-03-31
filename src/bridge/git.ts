import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { GitOriginRecord, GitOriginsResponse, GitRepositoryInfo } from "./shared.js";
import { isJsonRecord, uniqueStrings } from "./utils.js";

export async function resolveGitOrigins(
  body: unknown,
  fallbackDirs: string[],
): Promise<GitOriginsResponse> {
  const requestedDirs = readGitOriginDirectories(body);
  const dirs = requestedDirs.length > 0 ? requestedDirs : uniqueStrings(fallbackDirs);
  if (dirs.length === 0) {
    return {
      origins: [],
      homeDir: homedir(),
    };
  }

  const repositoriesByRoot = new Map<string, GitRepositoryInfo>();
  const originsByDir = new Map<string, GitOriginRecord>();

  for (const dir of dirs) {
    const origin = await resolveGitOrigin(dir, repositoriesByRoot);
    if (origin) {
      originsByDir.set(origin.dir, origin);
    }
  }

  for (const repository of repositoriesByRoot.values()) {
    const worktreeRoots = await listGitWorktreeRoots(repository.root);
    for (const worktreeRoot of worktreeRoots) {
      if (originsByDir.has(worktreeRoot)) {
        continue;
      }

      originsByDir.set(worktreeRoot, {
        dir: worktreeRoot,
        root: worktreeRoot,
        originUrl: repository.originUrl,
      });
    }
  }

  return {
    origins: Array.from(originsByDir.values()),
    homeDir: homedir(),
  };
}

function readGitOriginDirectories(body: unknown): string[] {
  const params = isJsonRecord(body) && isJsonRecord(body.params) ? body.params : body;
  if (!isJsonRecord(params) || !Array.isArray(params.dirs)) {
    return [];
  }

  return uniqueStrings(params.dirs);
}

async function resolveGitOrigin(
  dir: string,
  repositoriesByRoot: Map<string, GitRepositoryInfo>,
): Promise<GitOriginRecord | null> {
  const repository = await resolveGitRepository(dir, repositoriesByRoot);
  if (!repository) {
    return null;
  }

  return {
    dir,
    root: repository.root,
    originUrl: repository.originUrl,
  };
}

async function resolveGitRepository(
  dir: string,
  repositoriesByRoot: Map<string, GitRepositoryInfo>,
): Promise<GitRepositoryInfo | null> {
  let root: string;
  try {
    root = await runGitCommand(resolve(dir), ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }

  if (root.length === 0) {
    return null;
  }

  const existingRepository = repositoriesByRoot.get(root);
  if (existingRepository) {
    return existingRepository;
  }

  let originUrl: string | null;
  try {
    const configuredOriginUrl = await runGitCommand(root, ["config", "--get", "remote.origin.url"]);
    originUrl = configuredOriginUrl.length > 0 ? configuredOriginUrl : null;
  } catch {
    originUrl = null;
  }

  const repository: GitRepositoryInfo = {
    root,
    originUrl,
  };
  repositoriesByRoot.set(root, repository);
  return repository;
}

async function listGitWorktreeRoots(root: string): Promise<string[]> {
  try {
    const output = await runGitCommand(root, ["worktree", "list", "--porcelain"]);
    const worktreeRoots = output.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("worktree ")) {
        return [];
      }

      const worktreeRoot = line.slice("worktree ".length).trim();
      return worktreeRoot.length > 0 ? [worktreeRoot] : [];
    });
    return uniqueStrings([root, ...worktreeRoots]);
  } catch {
    return [root];
  }
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveOutput(stdout.trim());
      },
    );
  });
}
