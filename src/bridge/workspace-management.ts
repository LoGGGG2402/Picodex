import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { loadCodexDesktopProjects } from "../desktop/codex-desktop-projects.js";
import { debugLog } from "../core/debug.js";
import { saveWorkspaceRootRegistry, type WorkspaceRootRegistryState } from "../state/workspace-root-registry.js";
import { pickDirectoryOnHost } from "./host-picker.js";
import { isJsonRecord, normalizeError, normalizeNonEmptyString, uniqueStrings } from "./utils.js";

export interface WorkspaceManagementContext {
  cwd: string;
  codexDesktopGlobalStatePath: string;
  workspaceRootRegistryPath: string;
  workspaceRoots: Set<string>;
  workspaceRootLabels: Map<string, string>;
  globalState: Map<string, unknown>;
  pinnedThreadIds: Set<string>;
  getActiveWorkspaceRoot(): string | null;
  setActiveWorkspaceRoot(root: string | null): void;
  getDesktopImportPromptSeen(): boolean;
  setDesktopImportPromptSeen(seen: boolean): void;
  queueGlobalStateRegistryWrite(): void;
  emitBridgeMessage(message: { type: string; [key: string]: unknown }): void;
}

export async function listDesktopWorkspaceImportCandidates(
  bridge: WorkspaceManagementContext,
): Promise<{
  found: boolean;
  path: string;
  promptSeen: boolean;
  shouldPrompt: boolean;
  projects: Array<{
    root: string;
    label: string;
    activeInCodex: boolean;
    alreadyImported: boolean;
    available: boolean;
  }>;
}> {
  const loaded = await loadCodexDesktopProjects(bridge.codexDesktopGlobalStatePath);
  const projects = loaded.projects.map((project) => ({
    root: project.root,
    label: project.label,
    activeInCodex: project.active,
    alreadyImported: bridge.workspaceRoots.has(project.root),
    available: project.available,
  }));
  const promptSeen = bridge.getDesktopImportPromptSeen();
  const shouldPrompt =
    !promptSeen && projects.some((project) => project.available && !project.alreadyImported);

  return {
    found: loaded.found,
    path: loaded.path,
    promptSeen,
    shouldPrompt,
    projects,
  };
}

export async function applyDesktopWorkspaceImports(
  bridge: WorkspaceManagementContext,
  params: unknown,
): Promise<{
  importedRoots: string[];
  skippedRoots: string[];
  promptSeen: boolean;
}> {
  const requestedRoots =
    isJsonRecord(params) && Array.isArray(params.roots) ? uniqueStrings(params.roots) : [];
  const loaded = await loadCodexDesktopProjects(bridge.codexDesktopGlobalStatePath);
  const importableProjects = new Map(
    loaded.projects
      .filter((project) => project.available)
      .map((project) => [project.root, project] as const),
  );
  const importedRoots: string[] = [];
  const skippedRoots: string[] = [];

  for (const root of requestedRoots) {
    const project = importableProjects.get(root);
    if (!project || bridge.workspaceRoots.has(root)) {
      skippedRoots.push(root);
      continue;
    }

    ensureWorkspaceRoot(bridge, root, {
      label: project.label,
      setActive: false,
    });
    importedRoots.push(root);
  }

  bridge.setDesktopImportPromptSeen(true);
  await persistWorkspaceRootRegistry(bridge);

  if (importedRoots.length > 0) {
    emitWorkspaceRootsUpdated(bridge);
  } else {
    syncWorkspaceGlobalState(bridge);
  }

  return {
    importedRoots,
    skippedRoots,
    promptSeen: bridge.getDesktopImportPromptSeen(),
  };
}

export async function addManualWorkspaceRoot(
  bridge: WorkspaceManagementContext,
  params: unknown,
): Promise<{
  addedRoot: string | null;
  promptSeen: boolean;
}> {
  const requestedRoot =
    isJsonRecord(params) && typeof params.root === "string" ? params.root.trim() : "";
  if (!requestedRoot) {
    throw new Error("Workspace path is required.");
  }

  const resolvedRoot = resolve(requestedRoot);
  let stats;
  try {
    stats = await stat(resolvedRoot);
  } catch {
    throw new Error(`Workspace path does not exist: ${resolvedRoot}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolvedRoot}`);
  }

  ensureWorkspaceRoot(bridge, resolvedRoot, { setActive: true });
  await persistWorkspaceRootRegistry(bridge);
  emitWorkspaceRootsUpdated(bridge);

  return {
    addedRoot: resolvedRoot,
    promptSeen: bridge.getDesktopImportPromptSeen(),
  };
}

export async function pickDesktopWorkspaceDirectory(
  bridge: WorkspaceManagementContext,
  params: unknown,
): Promise<{ pickedRoot: string | null }> {
  const requestedStartPath = isJsonRecord(params) ? normalizeNonEmptyString(params.startPath) : null;
  const pickedRoot = await pickDirectoryOnHost(requestedStartPath ?? bridge.cwd);
  if (!pickedRoot) {
    return { pickedRoot: null };
  }

  const resolvedRoot = resolve(pickedRoot);
  let stats;
  try {
    stats = await stat(resolvedRoot);
  } catch {
    throw new Error(`Workspace path does not exist: ${resolvedRoot}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolvedRoot}`);
  }

  return { pickedRoot: resolvedRoot };
}

export async function dismissDesktopWorkspaceImportPrompt(
  bridge: WorkspaceManagementContext,
): Promise<{ promptSeen: boolean }> {
  bridge.setDesktopImportPromptSeen(true);
  await persistWorkspaceRootRegistry(bridge);
  return {
    promptSeen: bridge.getDesktopImportPromptSeen(),
  };
}

export async function handleOnboardingPickWorkspaceOrCreateDefault(
  bridge: WorkspaceManagementContext,
): Promise<void> {
  await persistWorkspaceRootRegistry(bridge);
  bridge.emitBridgeMessage({
    type: "electron-onboarding-pick-workspace-or-create-default-result",
    success: true,
  });
}

export async function handleOnboardingSkipWorkspace(
  bridge: WorkspaceManagementContext,
): Promise<void> {
  await persistWorkspaceRootRegistry(bridge);
  bridge.emitBridgeMessage({
    type: "electron-onboarding-skip-workspace-result",
    success: true,
  });
}

export async function handleWorkspaceRootsUpdated(
  bridge: WorkspaceManagementContext,
  message: Record<string, unknown>,
): Promise<void> {
  const roots = Array.isArray(message.roots)
    ? message.roots.filter((value): value is string => typeof value === "string")
    : [];
  if (roots.length === 0) {
    bridge.workspaceRoots.clear();
    bridge.setActiveWorkspaceRoot(null);
    await persistWorkspaceRootRegistry(bridge);
    emitWorkspaceRootsUpdated(bridge);
    return;
  }

  bridge.workspaceRoots.clear();
  for (const root of roots) {
    bridge.workspaceRoots.add(root);
    if (!bridge.workspaceRootLabels.has(root)) {
      bridge.workspaceRootLabels.set(root, basename(root) || "Workspace");
    }
  }

  const activeWorkspaceRoot = bridge.getActiveWorkspaceRoot();
  if (!activeWorkspaceRoot || !bridge.workspaceRoots.has(activeWorkspaceRoot)) {
    bridge.setActiveWorkspaceRoot(roots[0] ?? null);
  }

  await persistWorkspaceRootRegistry(bridge);
  emitWorkspaceRootsUpdated(bridge);
}

export async function handleSetActiveWorkspaceRoot(
  bridge: WorkspaceManagementContext,
  message: Record<string, unknown>,
): Promise<void> {
  const root = typeof message.root === "string" ? message.root : null;
  if (!root) {
    return;
  }

  ensureWorkspaceRoot(bridge, root, { setActive: true });
  await persistWorkspaceRootRegistry(bridge);
  emitWorkspaceRootsUpdated(bridge);
}

export async function handleRenameWorkspaceRootOption(
  bridge: WorkspaceManagementContext,
  message: Record<string, unknown>,
): Promise<void> {
  const root = typeof message.root === "string" ? message.root : null;
  if (!root) {
    return;
  }

  const label = typeof message.label === "string" ? message.label.trim() : "";
  if (label) {
    bridge.workspaceRootLabels.set(root, label);
  } else {
    bridge.workspaceRootLabels.delete(root);
  }

  await persistWorkspaceRootRegistry(bridge);
  bridge.emitBridgeMessage({ type: "workspace-root-options-updated" });
}

export async function addWorkspaceRootOption(
  bridge: WorkspaceManagementContext,
  body: unknown,
): Promise<{ success: boolean; root: string }> {
  const root = isJsonRecord(body) && typeof body.root === "string" ? body.root : null;
  const label = isJsonRecord(body) && typeof body.label === "string" ? body.label : null;
  const setActive = !isJsonRecord(body) || body.setActive !== false;

  if (!root) {
    openDesktopImportDialog(bridge, "manual");
    return { success: false, root: "" };
  }

  ensureWorkspaceRoot(bridge, root, { label, setActive });
  await persistWorkspaceRootRegistry(bridge);
  emitWorkspaceRootsUpdated(bridge);
  return { success: true, root };
}

export function applyWorkspaceRootRegistry(
  bridge: WorkspaceManagementContext,
  state: WorkspaceRootRegistryState,
): void {
  bridge.workspaceRoots.clear();
  bridge.workspaceRootLabels.clear();
  bridge.setDesktopImportPromptSeen(state.desktopImportPromptSeen);

  for (const root of state.roots) {
    bridge.workspaceRoots.add(root);
    const label = state.labels[root]?.trim();
    bridge.workspaceRootLabels.set(root, label || basename(root) || "Workspace");
  }

  bridge.setActiveWorkspaceRoot(
    state.activeRoot && bridge.workspaceRoots.has(state.activeRoot)
      ? state.activeRoot
      : (state.roots[0] ?? null),
  );
}

export async function persistWorkspaceRootRegistry(
  bridge: WorkspaceManagementContext,
): Promise<void> {
  const roots = Array.from(bridge.workspaceRoots);
  try {
    const labels = Object.fromEntries(
      roots.flatMap((root) => {
        const label = bridge.workspaceRootLabels.get(root)?.trim();
        return label ? [[root, label] as const] : [];
      }),
    );
    await saveWorkspaceRootRegistry(bridge.workspaceRootRegistryPath, {
      roots,
      labels,
      activeRoot:
        bridge.getActiveWorkspaceRoot() && bridge.workspaceRoots.has(bridge.getActiveWorkspaceRoot()!)
          ? bridge.getActiveWorkspaceRoot()
          : (roots[0] ?? null),
      desktopImportPromptSeen: bridge.getDesktopImportPromptSeen(),
    });
  } catch (error) {
    debugLog("app-server", "failed to persist workspace root registry", {
      error: normalizeError(error).message,
      path: bridge.workspaceRootRegistryPath,
    });
  }
}

export function ensureWorkspaceRoot(
  bridge: WorkspaceManagementContext,
  root: string,
  options: { label?: string | null; setActive?: boolean } = {},
): void {
  bridge.workspaceRoots.add(root);
  const label = options.label?.trim();
  if (label) {
    bridge.workspaceRootLabels.set(root, label);
  } else if (!bridge.workspaceRootLabels.has(root)) {
    bridge.workspaceRootLabels.set(root, basename(root) || "Workspace");
  }

  if (options.setActive !== false) {
    bridge.setActiveWorkspaceRoot(root);
  }
}

export function emitWorkspaceRootsUpdated(bridge: WorkspaceManagementContext): void {
  syncWorkspaceGlobalState(bridge);
  bridge.emitBridgeMessage({ type: "workspace-root-options-updated" });
  bridge.emitBridgeMessage({ type: "active-workspace-roots-updated" });
}

export function syncWorkspaceGlobalState(bridge: WorkspaceManagementContext): void {
  bridge.globalState.set("pinned-thread-ids", Array.from(bridge.pinnedThreadIds));
  bridge.globalState.set("active-workspace-roots", getActiveWorkspaceRoots(bridge));
  bridge.queueGlobalStateRegistryWrite();
}

export function getActiveWorkspaceRoots(bridge: WorkspaceManagementContext): string[] {
  const roots = Array.from(bridge.workspaceRoots);
  if (roots.length === 0) {
    return [];
  }

  const activeWorkspaceRoot = bridge.getActiveWorkspaceRoot();
  if (activeWorkspaceRoot && bridge.workspaceRoots.has(activeWorkspaceRoot)) {
    return [activeWorkspaceRoot, ...roots.filter((root) => root !== activeWorkspaceRoot)];
  }

  return roots;
}

export function getGitOriginFallbackDirectories(bridge: WorkspaceManagementContext): string[] {
  const activeRoots = getActiveWorkspaceRoots(bridge);
  if (activeRoots.length > 0) {
    return activeRoots;
  }

  return bridge.cwd.length > 0 ? [bridge.cwd] : [];
}

export function openDesktopImportDialog(
  bridge: WorkspaceManagementContext,
  mode: "first-run" | "manual",
): void {
  bridge.emitBridgeMessage({
    type: "picodex-open-desktop-import-dialog",
    mode,
  });
}
