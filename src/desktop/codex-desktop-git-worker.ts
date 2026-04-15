import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { ensureCodexDesktopWorkerScript, type CodexDesktopWorkerScript } from "./codex-bundle.js";
import { resolveCodexHomePath } from "./codex-home.js";
import { resolveCodexDesktopPaths } from "./codex-installation.js";
import { debugLog } from "../core/debug.js";

interface WorkerResponseResultError {
  message: string;
}

interface WorkerResponseResult {
  type: "ok" | "error";
  error?: WorkerResponseResultError;
  value?: unknown;
}

interface WorkerResponseEnvelope {
  type: "worker-response";
  workerId: string;
  response: {
    id: string | number;
    method: string;
    result: WorkerResponseResult;
  };
}

interface WorkerMainRpcRequestEnvelope {
  type: "worker-main-rpc-request";
  workerId: string;
  requestId: string;
  method: string;
  params?: unknown;
}

interface WorkerMainRpcResponseEnvelope {
  type: "worker-main-rpc-response";
  workerId: string;
  requestId: string;
  method: string;
  result: WorkerResponseResult;
}

interface WorkerMainRpcEventEnvelope {
  type: "worker-main-rpc-event";
  workerId: string;
  method: "command-exec-output-delta" | "fs-watch-changed" | "fs-watch-closed";
  params: Record<string, unknown>;
}

interface WorktreeCleanupInputs {
  hostKey: string;
  threadIds: string[];
}

interface FileReadParams {
  path: string;
}

interface FileWriteParams extends FileReadParams {
  dataBase64: string;
}

interface CreateDirectoryParams {
  path: string;
  recursive?: boolean;
}

interface FileMetadataParams {
  path: string;
}

interface ReadDirectoryParams {
  path: string;
}

interface RemovePathParams {
  path: string;
  recursive?: boolean;
  force?: boolean;
}

interface CopyPathParams {
  sourcePath: string;
  destinationPath: string;
  recursive?: boolean;
}

interface FileWatchParams {
  path: string;
  watchId: string;
}

interface FileUnwatchParams {
  watchId: string;
}

interface CommandExecStartParams {
  processId: string;
  command: string[] | string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  disableTimeout?: boolean;
}

interface CommandExecWriteParams {
  processId: string;
  delta?: Uint8Array;
  closeStdin?: boolean;
}

interface CommandExecResizeParams {
  processId: string;
  size?: unknown;
}

interface CommandExecTerminateParams {
  processId: string;
}

interface CommandExecSession {
  process: ChildProcess;
  timeout: NodeJS.Timeout | null;
}

interface FileWatchSession {
  watchId: string;
  watcher: FSWatcher;
  path: string;
  closed: boolean;
}

export interface CodexDesktopGitWorkerBridge {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  send(message: unknown): Promise<void>;
  subscribe(): Promise<void>;
  unsubscribe(): Promise<void>;
  close(): Promise<void>;
}

interface PendingWorkerRequest {
  id: string | number;
  method: string;
}

interface CodexDesktopGitWorkerBridgeOptions {
  appPath: string;
  appAsarPath?: string;
  resolveWorkerScript?: () => Promise<CodexDesktopWorkerScript>;
  WorkerClass?: typeof Worker;
  codexAppSessionId?: string;
}

export class DefaultCodexDesktopGitWorkerBridge
  extends EventEmitter
  implements CodexDesktopGitWorkerBridge
{
  private readonly appPath: string;
  private readonly appAsarPath?: string;
  private readonly resolveWorkerScript: () => Promise<CodexDesktopWorkerScript>;
  private readonly WorkerClass: typeof Worker;
  private readonly codexAppSessionId: string;
  private readonly pendingRequests = new Map<string, PendingWorkerRequest>();
  private readonly commandExecs = new Map<string, CommandExecSession>();
  private readonly fileWatches = new Map<string, FileWatchSession>();
  private worker: Worker | null = null;
  private workerStartPromise: Promise<Worker> | null = null;
  private subscriberCount = 0;
  private isClosing = false;

  constructor(options: CodexDesktopGitWorkerBridgeOptions) {
    super();
    this.appPath = options.appPath;
    this.appAsarPath = options.appAsarPath;
    this.resolveWorkerScript =
      options.resolveWorkerScript ??
      (async () =>
        ensureCodexDesktopWorkerScript(
          await resolveCodexDesktopPaths({
            appPath: this.appPath,
            appAsarPath: this.appAsarPath,
          }),
        ));
    this.WorkerClass = options.WorkerClass ?? Worker;
    this.codexAppSessionId = options.codexAppSessionId ?? randomUUID();
  }

  async send(message: unknown): Promise<void> {
    const request = parseGitWorkerRequest(message);
    if (request) {
      this.pendingRequests.set(String(request.id), request);
    } else {
      const cancellation = parseGitWorkerCancel(message);
      if (cancellation) {
        this.pendingRequests.delete(String(cancellation.id));
      }
    }

    try {
      const worker = await this.ensureWorker();
      worker.postMessage(message);
    } catch (error) {
      const normalized = normalizeError(error);
      debugLog("git-worker", "failed to send message", {
        error: normalized.message,
      });
      const requestToReject = request ? this.pendingRequests.get(String(request.id)) : null;
      if (requestToReject) {
        this.pendingRequests.delete(String(requestToReject.id));
        this.emit("message", buildWorkerErrorResponse(requestToReject, normalized));
      }
      this.emit("error", normalized);
    }
  }

  async subscribe(): Promise<void> {
    this.subscriberCount += 1;
    try {
      await this.ensureWorker();
    } catch (error) {
      this.emit("error", normalizeError(error));
    }
  }

  async unsubscribe(): Promise<void> {
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
  }

  async close(): Promise<void> {
    this.isClosing = true;
    this.disposeFileWatches();
    this.disposeCommandExecs();
    const worker = this.worker;
    this.worker = null;
    this.workerStartPromise = null;
    this.pendingRequests.clear();
    if (!worker) {
      return;
    }
    await worker.terminate();
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) {
      return this.worker;
    }
    if (this.workerStartPromise) {
      return this.workerStartPromise;
    }

    this.workerStartPromise = this.startWorker();
    try {
      const worker = await this.workerStartPromise;
      this.worker = worker;
      return worker;
    } finally {
      this.workerStartPromise = null;
    }
  }

  private async startWorker(): Promise<Worker> {
    const script = await this.resolveWorkerScript();
    const worker = new this.WorkerClass(script.workerPath, {
      name: "git",
      workerData: {
        workerId: "git",
        sentryInitOptions: {
          buildFlavor: script.metadata.buildFlavor,
          appVersion: script.metadata.version,
          buildNumber: script.metadata.buildNumber,
          codexAppSessionId: this.codexAppSessionId,
        },
        maxLogLevel: process.env.POCODEX_DEBUG ? "debug" : "warning",
        sentryRewriteFramesRoot: script.metadata.appPath,
        spawnInsideWsl: false,
      },
    });

    worker.on("message", (message) => {
      if (isWorkerMainRpcRequestEnvelope(message)) {
        void this.handleMainRpcRequest(worker, message);
        return;
      }

      const responseId = extractWorkerResponseId(message);
      if (responseId) {
        this.pendingRequests.delete(responseId);
      }

      this.emit("message", message);
    });

    worker.on("error", (error) => {
      this.emit("error", normalizeError(error));
    });

    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.worker = null;
      }
      if (this.isClosing) {
        return;
      }

      const error = new Error(`Codex desktop git worker exited unexpectedly with code ${code}.`);
      const pending = [...this.pendingRequests.values()];
      this.pendingRequests.clear();
      for (const request of pending) {
        this.emit("message", buildWorkerErrorResponse(request, error));
      }
      this.emit("error", error);
    });

    worker.unref();

    debugLog("git-worker", "spawned desktop git worker", {
      workerPath: script.workerPath,
      version: script.metadata.version,
      subscribers: this.subscriberCount,
    });

    return worker;
  }

  private async handleMainRpcRequest(
    worker: Worker,
    message: WorkerMainRpcRequestEnvelope,
  ): Promise<void> {
    if (message.workerId !== "git") {
      return;
    }

    try {
      const value = await this.handleMainRpcMethod(worker, message.method, message.params);
      worker.postMessage(
        buildMainRpcResponse(message.requestId, message.method, {
          type: "ok",
          value,
        }),
      );
    } catch (error) {
      worker.postMessage(
        buildMainRpcResponse(message.requestId, message.method, {
          type: "error",
          error: {
            message: normalizeError(error).message,
          },
        }),
      );
    }
  }

  private async handleMainRpcMethod(
    worker: Worker,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "worktree-cleanup-inputs":
        return buildWorktreeCleanupResponse(parseWorktreeCleanupInputs(params));
      case "codex-home":
        return { codexHome: resolveCodexHomePath() };
      case "platform-family":
        return platform() === "win32" ? "windows" : "unix";
      case "fs-read-file":
        return this.readFile(parseFileReadParams(params));
      case "fs-write-file":
        await this.writeFile(parseFileWriteParams(params));
        return {};
      case "fs-create-directory":
        await this.createDirectory(parseCreateDirectoryParams(params));
        return {};
      case "fs-get-metadata":
        return this.getMetadata(parseFileMetadataParams(params));
      case "fs-read-directory":
        return this.readDirectory(parseReadDirectoryParams(params));
      case "fs-remove":
        await this.removePath(parseRemovePathParams(params));
        return {};
      case "fs-copy":
        await this.copyPath(parseCopyPathParams(params));
        return {};
      case "fs-watch":
        return this.startFileWatch(worker, parseFileWatchParams(params));
      case "fs-unwatch":
        await this.stopFileWatch(worker, parseFileUnwatchParams(params), false);
        return {};
      case "command-exec-start":
        return this.startCommandExec(worker, parseCommandExecStartParams(params));
      case "command-exec-write":
        await this.writeCommandExec(parseCommandExecWriteParams(params));
        return {};
      case "command-exec-resize":
        await this.resizeCommandExec(parseCommandExecResizeParams(params));
        return {};
      case "command-exec-terminate":
        await this.terminateCommandExec(parseCommandExecTerminateParams(params));
        return {};
      case "worker-exit":
        queueMicrotask(() => {
          void worker.terminate().catch(() => {});
        });
        return {};
      default:
        throw new Error(`Unsupported git worker main RPC method "${method}" in Picodex.`);
    }
  }

  private async readFile(params: FileReadParams): Promise<{ dataBase64: string }> {
    const data = await readFile(resolve(params.path));
    return { dataBase64: data.toString("base64") };
  }

  private async writeFile(params: FileWriteParams): Promise<void> {
    const targetPath = resolve(params.path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, Buffer.from(params.dataBase64, "base64"));
  }

  private async createDirectory(params: CreateDirectoryParams): Promise<void> {
    await mkdir(resolve(params.path), { recursive: params.recursive ?? true });
  }

  private async getMetadata(params: FileMetadataParams): Promise<{
    isDirectory: boolean;
    isFile: boolean;
    createdAtMs: number;
    modifiedAtMs: number;
    size: number;
  }> {
    const metadata = await stat(resolve(params.path));
    return {
      isDirectory: metadata.isDirectory(),
      isFile: metadata.isFile(),
      createdAtMs: metadata.birthtimeMs,
      modifiedAtMs: metadata.mtimeMs,
      size: metadata.size,
    };
  }

  private async readDirectory(params: ReadDirectoryParams): Promise<{
    entries: Array<{ fileName: string; isDirectory: boolean; isFile: boolean }>;
  }> {
    const entries = await readdir(resolve(params.path), { withFileTypes: true });
    return {
      entries: entries.map((entry) => ({
        fileName: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      })),
    };
  }

  private async removePath(params: RemovePathParams): Promise<void> {
    await rm(resolve(params.path), {
      recursive: params.recursive ?? true,
      force: params.force ?? true,
    });
  }

  private async copyPath(params: CopyPathParams): Promise<void> {
    const sourcePath = resolve(params.sourcePath);
    const destinationPath = resolve(params.destinationPath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, {
      force: true,
      recursive: params.recursive ?? false,
    });
  }

  private startFileWatch(
    worker: Worker,
    params: FileWatchParams,
  ): { path: string } {
    const watchPath = resolve(params.path);
    this.closeFileWatch(worker, params.watchId, false);

    const session: FileWatchSession = {
      watchId: params.watchId,
      watcher: watch(watchPath, { persistent: false }, (_eventType, filename) => {
        if (session.closed) {
          return;
        }
        const changedPaths =
          typeof filename === "string" && filename.length > 0
            ? [join(watchPath, filename)]
            : [];
        worker.postMessage(
          buildMainRpcEvent("fs-watch-changed", {
            watchId: params.watchId,
            path: watchPath,
            changedPaths,
          }),
        );
      }),
      path: watchPath,
      closed: false,
    };

    session.watcher.on("error", (error) => {
      debugLog("git-worker", "file watch failed", {
        path: watchPath,
        error: normalizeError(error).message,
      });
      this.closeFileWatch(worker, params.watchId, true, normalizeError(error).message);
    });

    session.watcher.on("close", () => {
      if (!session.closed) {
        this.closeFileWatch(worker, params.watchId, true, "closed");
      }
    });

    this.fileWatches.set(params.watchId, session);
    return { path: watchPath };
  }

  private async stopFileWatch(
    worker: Worker,
    params: FileUnwatchParams,
    emitEvent: boolean,
  ): Promise<void> {
    this.closeFileWatch(worker, params.watchId, emitEvent, emitEvent ? "disposed" : undefined);
  }

  private closeFileWatch(
    worker: Worker,
    watchId: string,
    emitEvent: boolean,
    reason = "disposed",
  ): void {
    const session = this.fileWatches.get(watchId);
    if (!session) {
      return;
    }

    this.fileWatches.delete(watchId);
    session.closed = true;
    session.watcher.removeAllListeners();
    session.watcher.close();

    if (emitEvent) {
      worker.postMessage(
        buildMainRpcEvent("fs-watch-closed", {
          watchId,
          path: session.path,
          reason,
        }),
      );
    }
  }

  private async startCommandExec(
    worker: Worker,
    params: CommandExecStartParams,
  ): Promise<{ exitCode: number | null }> {
    this.disposeCommandExec(params.processId);

    const { command, args, useShell } = normalizeCommand(params.command);
    const child = spawn(command, args, {
      cwd: typeof params.cwd === "string" && params.cwd.trim().length > 0 ? resolve(params.cwd) : process.cwd(),
      env: {
        ...process.env,
        ...normalizeStringRecord(params.env),
      },
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const session: CommandExecSession = {
      process: child,
      timeout: null,
    };
    this.commandExecs.set(params.processId, session);

    if (!params.disableTimeout && typeof params.timeoutMs === "number" && params.timeoutMs > 0) {
      session.timeout = setTimeout(() => {
        child.kill();
      }, params.timeoutMs);
      session.timeout.unref?.();
    }

    const emitOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      worker.postMessage(
        buildMainRpcEvent("command-exec-output-delta", {
          processId: params.processId,
          stream,
          delta: {
            chunk: new Uint8Array(chunk),
            capReached: false,
          },
        }),
      );
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      emitOutput("stdout", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      emitOutput("stderr", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    return new Promise<{ exitCode: number | null }>((resolveResult, rejectResult) => {
      child.once("error", (error) => {
        this.disposeCommandExec(params.processId);
        rejectResult(error);
      });

      child.once("exit", (code) => {
        this.disposeCommandExec(params.processId);
        resolveResult({ exitCode: typeof code === "number" ? code : null });
      });
    });
  }

  private async writeCommandExec(params: CommandExecWriteParams): Promise<void> {
    const session = this.commandExecs.get(params.processId);
    if (!session) {
      return;
    }
    if (params.delta && params.delta.byteLength > 0 && session.process.stdin) {
      session.process.stdin.write(Buffer.from(params.delta));
    }
    if (params.closeStdin && session.process.stdin) {
      session.process.stdin.end();
    }
  }

  private async resizeCommandExec(_params: CommandExecResizeParams): Promise<void> {}

  private async terminateCommandExec(params: CommandExecTerminateParams): Promise<void> {
    const session = this.commandExecs.get(params.processId);
    if (!session) {
      return;
    }
    session.process.kill();
  }

  private disposeCommandExec(processId: string): void {
    const session = this.commandExecs.get(processId);
    if (!session) {
      return;
    }
    this.commandExecs.delete(processId);
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
  }

  private disposeCommandExecs(): void {
    for (const [processId, session] of this.commandExecs.entries()) {
      this.commandExecs.delete(processId);
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
      session.process.kill();
    }
  }

  private disposeFileWatches(): void {
    for (const session of this.fileWatches.values()) {
      session.closed = true;
      session.watcher.removeAllListeners();
      session.watcher.close();
    }
    this.fileWatches.clear();
  }
}

function buildWorktreeCleanupResponse(params: WorktreeCleanupInputs): {
  threadMetadataById: Record<string, { updatedAtMs: number; isInProgress: boolean }>;
  pinnedThreadIds: string[];
  protectPreMigrationOwnerlessWorktrees: boolean;
  autoCleanupEnabled: boolean;
  keepCount: number;
} {
  return {
    threadMetadataById: Object.fromEntries(
      params.threadIds.map((threadId) => [
        threadId,
        {
          updatedAtMs: Date.now(),
          isInProgress: true,
        },
      ]),
    ),
    pinnedThreadIds: [],
    protectPreMigrationOwnerlessWorktrees: false,
    autoCleanupEnabled: false,
    keepCount: 0,
  };
}

function buildMainRpcResponse(
  requestId: string,
  method: string,
  result: WorkerResponseResult,
): WorkerMainRpcResponseEnvelope {
  return {
    type: "worker-main-rpc-response",
    workerId: "git",
    requestId,
    method,
    result,
  };
}

function buildMainRpcEvent(
  method: WorkerMainRpcEventEnvelope["method"],
  params: Record<string, unknown>,
): WorkerMainRpcEventEnvelope {
  return {
    type: "worker-main-rpc-event",
    workerId: "git",
    method,
    params,
  };
}

function parseWorktreeCleanupInputs(value: unknown): WorktreeCleanupInputs {
  if (!isJsonRecord(value)) {
    return {
      hostKey: "local",
      threadIds: [],
    };
  }

  return {
    hostKey: typeof value.hostKey === "string" ? value.hostKey : "local",
    threadIds: Array.isArray(value.threadIds)
      ? value.threadIds.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function parseGitWorkerRequest(value: unknown): PendingWorkerRequest | null {
  if (!isJsonRecord(value) || value.type !== "worker-request") {
    return null;
  }
  const request = isJsonRecord(value.request) ? value.request : null;
  if (
    !request ||
    (typeof request.id !== "string" && typeof request.id !== "number") ||
    typeof request.method !== "string"
  ) {
    return null;
  }
  return {
    id: request.id,
    method: request.method,
  };
}

function parseGitWorkerCancel(value: unknown): { id: string | number } | null {
  if (!isJsonRecord(value) || value.type !== "worker-request-cancel") {
    return null;
  }
  if (typeof value.id !== "string" && typeof value.id !== "number") {
    return null;
  }
  return { id: value.id };
}

function parseFileReadParams(value: unknown): FileReadParams {
  const path = readRequiredStringField(value, "path");
  return { path };
}

function parseFileWriteParams(value: unknown): FileWriteParams {
  return {
    path: readRequiredStringField(value, "path"),
    dataBase64: readRequiredStringField(value, "dataBase64"),
  };
}

function parseCreateDirectoryParams(value: unknown): CreateDirectoryParams {
  return {
    path: readRequiredStringField(value, "path"),
    recursive: readOptionalBooleanField(value, "recursive"),
  };
}

function parseFileMetadataParams(value: unknown): FileMetadataParams {
  return {
    path: readRequiredStringField(value, "path"),
  };
}

function parseReadDirectoryParams(value: unknown): ReadDirectoryParams {
  return {
    path: readRequiredStringField(value, "path"),
  };
}

function parseRemovePathParams(value: unknown): RemovePathParams {
  return {
    path: readRequiredStringField(value, "path"),
    recursive: readOptionalBooleanField(value, "recursive"),
    force: readOptionalBooleanField(value, "force"),
  };
}

function parseCopyPathParams(value: unknown): CopyPathParams {
  return {
    sourcePath: readRequiredStringField(value, "sourcePath"),
    destinationPath: readRequiredStringField(value, "destinationPath"),
    recursive: readOptionalBooleanField(value, "recursive"),
  };
}

function parseFileWatchParams(value: unknown): FileWatchParams {
  return {
    path: readRequiredStringField(value, "path"),
    watchId: readRequiredStringField(value, "watchId"),
  };
}

function parseFileUnwatchParams(value: unknown): FileUnwatchParams {
  return {
    watchId: readRequiredStringField(value, "watchId"),
  };
}

function parseCommandExecStartParams(value: unknown): CommandExecStartParams {
  if (!isJsonRecord(value)) {
    throw new Error("Invalid command-exec-start params.");
  }

  const processId = readRequiredStringField(value, "processId");
  const commandValue = value.command;
  const command =
    typeof commandValue === "string"
      ? commandValue
      : Array.isArray(commandValue)
        ? commandValue.filter((item): item is string => typeof item === "string")
        : null;

  if (!command || (Array.isArray(command) && command.length === 0)) {
    throw new Error('Missing command-exec-start "command".');
  }

  return {
    processId,
    command,
    cwd: readOptionalStringField(value, "cwd"),
    env: normalizeStringRecord(value.env),
    timeoutMs:
      typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) ? value.timeoutMs : undefined,
    disableTimeout: readOptionalBooleanField(value, "disableTimeout"),
  };
}

function parseCommandExecWriteParams(value: unknown): CommandExecWriteParams {
  if (!isJsonRecord(value)) {
    throw new Error("Invalid command-exec-write params.");
  }
  const delta = value.delta;
  return {
    processId: readRequiredStringField(value, "processId"),
    delta:
      delta instanceof Uint8Array
        ? delta
        : Array.isArray(delta)
          ? Uint8Array.from(delta.filter((item): item is number => typeof item === "number"))
          : undefined,
    closeStdin: readOptionalBooleanField(value, "closeStdin"),
  };
}

function parseCommandExecResizeParams(value: unknown): CommandExecResizeParams {
  return {
    processId: readRequiredStringField(value, "processId"),
    size: isJsonRecord(value) ? value.size : undefined,
  };
}

function parseCommandExecTerminateParams(value: unknown): CommandExecTerminateParams {
  return {
    processId: readRequiredStringField(value, "processId"),
  };
}

function buildWorkerErrorResponse(
  request: PendingWorkerRequest,
  error: Error,
): WorkerResponseEnvelope {
  return {
    type: "worker-response",
    workerId: "git",
    response: {
      id: request.id,
      method: request.method,
      result: {
        type: "error",
        error: {
          message: error.message,
        },
      },
    },
  };
}

function extractWorkerResponseId(message: unknown): string | null {
  if (!isJsonRecord(message) || message.type !== "worker-response") {
    return null;
  }
  const response = isJsonRecord(message.response) ? message.response : null;
  if (!response || (typeof response.id !== "string" && typeof response.id !== "number")) {
    return null;
  }
  return String(response.id);
}

function isWorkerMainRpcRequestEnvelope(value: unknown): value is WorkerMainRpcRequestEnvelope {
  return (
    isJsonRecord(value) &&
    value.type === "worker-main-rpc-request" &&
    typeof value.workerId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.method === "string"
  );
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRequiredStringField(value: unknown, field: string): string {
  if (!isJsonRecord(value) || typeof value[field] !== "string" || value[field].trim().length === 0) {
    throw new Error(`Missing "${field}" in git worker main RPC params.`);
  }
  return value[field].trim();
}

function readOptionalStringField(value: unknown, field: string): string | undefined {
  if (!isJsonRecord(value) || typeof value[field] !== "string") {
    return undefined;
  }
  const trimmed = value[field].trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalBooleanField(value: unknown, field: string): boolean | undefined {
  return isJsonRecord(value) && typeof value[field] === "boolean" ? value[field] : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isJsonRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

function normalizeCommand(command: string[] | string): {
  command: string;
  args: string[];
  useShell: boolean;
} {
  if (typeof command === "string") {
    return {
      command,
      args: [],
      useShell: true,
    };
  }

  const [executable, ...args] = command;
  if (!executable) {
    throw new Error("Missing command executable.");
  }

  return {
    command: executable,
    args,
    useShell: false,
  };
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
