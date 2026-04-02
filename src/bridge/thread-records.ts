import { open, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { debugLog } from "../core/debug.js";
import type { JsonRecord } from "../core/protocol.js";
import {
  MAX_THREAD_LIST_SUBAGENT_READS,
  type ResolvedSessionSyntheticCollabCallRecord,
  type SessionSubagentMetadata,
  type SessionSyntheticCollabCallRecord,
  type SessionThreadIndexRecord,
} from "./shared.js";
import {
  compareThreadListRecords,
  injectSyntheticCollabToolCalls,
  isResolvedSyntheticCollabCall,
  matchesThreadListFilters,
  normalizeThreadListRequestParams,
  parseSessionSubagentMetadata,
  parseSessionSyntheticCollabCalls,
  parseSessionThreadIndexRecord,
} from "./threads.js";
import {
  arraysReferenceEqual,
  extractThreadSessionPath,
  hasNonEmptyString,
  hasSubagentThreadSource,
  isArchivedSessionPath,
  isJsonRecord,
  isMissingFileError,
  normalizeError,
  normalizeNonEmptyString,
  uniqueStrings,
} from "./utils.js";

export interface ThreadRecordsBridgeContext {
  sessionSubagentMetadataCache: Map<string, Promise<SessionSubagentMetadata | null>>;
  sessionThreadIndexCache: Map<string, Promise<SessionThreadIndexRecord | null>>;
  sessionSyntheticCollabCallCache: Map<string, Promise<SessionSyntheticCollabCallRecord[]>>;
  threadRecordReadCache: Map<string, Promise<JsonRecord | null>>;
  getCodexHomePath(): string;
  sendLocalRequest(method: string, params?: unknown): Promise<unknown>;
}

const THREAD_READ_CONCURRENCY = 4;
const THREAD_ENRICH_CONCURRENCY = 3;
const THREAD_READ_OVERLOAD_RETRY_DELAYS_MS = [80, 160, 320, 640];

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async withPermit<T>(run: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await run();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

const threadReadSemaphore = new AsyncSemaphore(THREAD_READ_CONCURRENCY);

export async function enrichThreadPayloadForMethod(
  bridge: ThreadRecordsBridgeContext,
  method: string | null,
  payload: unknown,
  requestParams?: unknown,
): Promise<unknown> {
  if (!method?.startsWith("thread/")) {
    return payload;
  }

  if (Array.isArray(payload)) {
    return mapWithConcurrency(
      payload,
      THREAD_ENRICH_CONCURRENCY,
      (item) => enrichThreadPayloadForMethod(bridge, method, item, requestParams),
    );
  }

  if (!isJsonRecord(payload)) {
    return payload;
  }

  const maybeThreadRecord = await enrichThreadRecord(bridge, payload);
  if (maybeThreadRecord !== payload) {
    return maybeThreadRecord;
  }

  let changed = false;
  const nextPayload: JsonRecord = { ...payload };

  if (Array.isArray(payload.data)) {
    const enrichedData = await mapWithConcurrency(
      payload.data,
      THREAD_ENRICH_CONCURRENCY,
      (item) => enrichThreadRecord(bridge, item),
    );
    if (!arraysReferenceEqual(payload.data, enrichedData)) {
      nextPayload.data = enrichedData;
      changed = true;
    }
  }

  if (Array.isArray(payload.threads)) {
    const enrichedThreads = await mapWithConcurrency(
      payload.threads,
      THREAD_ENRICH_CONCURRENCY,
      (item) => enrichThreadRecord(bridge, item),
    );
    if (!arraysReferenceEqual(payload.threads, enrichedThreads)) {
      nextPayload.threads = enrichedThreads;
      changed = true;
    }
  }

  if (isJsonRecord(payload.thread)) {
    const enrichedThread = await enrichThreadRecord(bridge, payload.thread);
    if (enrichedThread !== payload.thread) {
      nextPayload.thread = enrichedThread;
      changed = true;
    }
  }

  if (isJsonRecord(payload.conversation)) {
    const enrichedConversation = await enrichThreadRecord(bridge, payload.conversation);
    if (enrichedConversation !== payload.conversation) {
      nextPayload.conversation = enrichedConversation;
      changed = true;
    }
  }

  const enrichedPayload = changed ? nextPayload : payload;
  if (method === "thread/list") {
    return augmentThreadListPayload(bridge, enrichedPayload, requestParams);
  }

  return enrichedPayload;
}

export async function enrichThreadRecord(
  bridge: ThreadRecordsBridgeContext,
  payload: unknown,
): Promise<unknown> {
  if (!isJsonRecord(payload)) {
    return payload;
  }

  const threadPath = extractThreadSessionPath(payload);
  if (!threadPath) {
    return payload;
  }

  let changed = false;
  const nextPayload: JsonRecord = { ...payload };

  if (!hasSubagentThreadSource(payload.source)) {
    const metadata = await readSessionSubagentMetadata(bridge, threadPath);
    if (metadata) {
      nextPayload.source = metadata.source;
      changed = true;

      if (!hasNonEmptyString(payload.agentNickname) && metadata.agentNickname !== null) {
        nextPayload.agentNickname = metadata.agentNickname;
      }

      if (!hasNonEmptyString(payload.agentRole) && metadata.agentRole !== null) {
        nextPayload.agentRole = metadata.agentRole;
      }
    }
  }

  if (Array.isArray(payload.turns) && typeof payload.id === "string") {
    const syntheticCollabCalls = await readSessionSyntheticCollabCalls(bridge, threadPath);
    const resolvedSyntheticCollabCalls = await resolveSessionSyntheticCollabCalls(
      bridge,
      syntheticCollabCalls,
      payload.id,
      isArchivedSessionPath(threadPath),
    );
    const enrichedTurns = injectSyntheticCollabToolCalls(
      payload.turns,
      payload.id,
      resolvedSyntheticCollabCalls,
    );
    if (!arraysReferenceEqual(payload.turns, enrichedTurns)) {
      nextPayload.turns = enrichedTurns;
      changed = true;
      debugLog("app-server", "injected synthetic collab tool calls", {
        threadId: payload.id,
        sessionPath: threadPath,
        syntheticCollabCallCount: resolvedSyntheticCollabCalls.length,
      });
    }
  }

  return changed ? nextPayload : payload;
}

export async function readSessionSubagentMetadata(
  bridge: ThreadRecordsBridgeContext,
  threadPath: string,
): Promise<SessionSubagentMetadata | null> {
  const normalizedPath = resolve(threadPath);
  const cached = bridge.sessionSubagentMetadataCache.get(normalizedPath);
  if (cached) {
    return cached;
  }

  const pending = loadSessionSubagentMetadata(normalizedPath);
  bridge.sessionSubagentMetadataCache.set(normalizedPath, pending);
  return pending;
}

export async function readSessionSyntheticCollabCalls(
  bridge: ThreadRecordsBridgeContext,
  threadPath: string,
): Promise<SessionSyntheticCollabCallRecord[]> {
  const normalizedPath = resolve(threadPath);
  const cached = bridge.sessionSyntheticCollabCallCache.get(normalizedPath);
  if (cached) {
    return cached;
  }

  const pending = loadSessionSyntheticCollabCalls(normalizedPath);
  bridge.sessionSyntheticCollabCallCache.set(normalizedPath, pending);
  return pending;
}

export async function resolveSessionSyntheticCollabCalls(
  bridge: ThreadRecordsBridgeContext,
  collabCalls: readonly SessionSyntheticCollabCallRecord[],
  parentThreadId: string,
  archived: boolean,
): Promise<ResolvedSessionSyntheticCollabCallRecord[]> {
  if (collabCalls.length === 0) {
    return [];
  }

  const indexedSessions = (await listIndexedSubagentSessions(bridge, archived))
    .filter((record) => record.parentThreadId === parentThreadId)
    .sort((left, right) => {
      const leftTimestamp = left.timestamp ?? Number.POSITIVE_INFINITY;
      const rightTimestamp = right.timestamp ?? Number.POSITIVE_INFINITY;
      if (leftTimestamp !== rightTimestamp) {
        return leftTimestamp - rightTimestamp;
      }
      return left.threadId.localeCompare(right.threadId);
    });

  const usedAgentIds = new Set(
    collabCalls
      .map((call) => call.agentId)
      .filter((agentId): agentId is string => typeof agentId === "string"),
  );

  const unresolvedCalls = collabCalls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.agentId === null)
    .sort((left, right) => {
      const leftTimestamp = left.call.timestampMs ?? Number.POSITIVE_INFINITY;
      const rightTimestamp = right.call.timestampMs ?? Number.POSITIVE_INFINITY;
      if (leftTimestamp !== rightTimestamp) {
        return leftTimestamp - rightTimestamp;
      }
      return left.index - right.index;
    });

  const resolvedCalls = [...collabCalls];
  for (const { call, index } of unresolvedCalls) {
    const expectedTimestampSeconds =
      call.timestampMs === null ? null : Math.floor(call.timestampMs / 1000) - 5;
    let matchIndex = indexedSessions.findIndex(
      (record) =>
        !usedAgentIds.has(record.threadId) &&
        (expectedTimestampSeconds === null ||
          record.timestamp === null ||
          record.timestamp >= expectedTimestampSeconds),
    );
    if (matchIndex < 0) {
      matchIndex = indexedSessions.findIndex((record) => !usedAgentIds.has(record.threadId));
    }
    if (matchIndex < 0) {
      continue;
    }

    const matchedSession = indexedSessions[matchIndex];
    usedAgentIds.add(matchedSession.threadId);
    resolvedCalls[index] = {
      ...call,
      agentId: matchedSession.threadId,
    };
  }

  const resolvedAgentIds = uniqueStrings(
    resolvedCalls
      .map((call) => call.agentId)
      .filter((agentId): agentId is string => typeof agentId === "string"),
  );
  if (resolvedAgentIds.length === 0) {
    return [];
  }

  const threadEntries = await mapWithConcurrency(
    resolvedAgentIds,
    THREAD_ENRICH_CONCURRENCY,
    async (agentId) => [agentId, await readThreadRecordById(bridge, agentId)] as const,
  );
  const threadByAgentId = new Map<string, JsonRecord | null>(threadEntries);

  return resolvedCalls
    .filter(isResolvedSyntheticCollabCall)
    .map((call) => {
      const receiverThread = threadByAgentId.get(call.agentId) ?? null;
      const threadNickname = receiverThread ? normalizeNonEmptyString(receiverThread.agentNickname) : null;
      const threadRole = receiverThread ? normalizeNonEmptyString(receiverThread.agentRole) : null;
      return {
        ...call,
        agentNickname: call.agentNickname ?? threadNickname,
        agentRole: call.agentRole ?? threadRole,
        receiverThread,
      };
    });
}

export async function augmentThreadListPayload(
  bridge: ThreadRecordsBridgeContext,
  payload: unknown,
  requestParams: unknown,
): Promise<unknown> {
  if (!isJsonRecord(payload) || !Array.isArray(payload.data)) {
    return payload;
  }

  const params = normalizeThreadListRequestParams(requestParams);
  const existingIds = new Set<string>();
  for (const item of payload.data) {
    if (isJsonRecord(item) && typeof item.id === "string") {
      existingIds.add(item.id);
    }
  }

  const indexedSessions = await listIndexedSubagentSessions(bridge, params.archived);
  const missingCandidates = indexedSessions
    .filter((record) => !existingIds.has(record.threadId))
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
    .slice(
      0,
      Math.max(
        params.limit ?? MAX_THREAD_LIST_SUBAGENT_READS,
        MAX_THREAD_LIST_SUBAGENT_READS,
      ),
    );

  if (missingCandidates.length === 0) {
    return payload;
  }

  const supplementalThreads: JsonRecord[] = [];
  for (const candidate of missingCandidates) {
    const thread = await readThreadRecordById(bridge, candidate.threadId);
    if (!thread || existingIds.has(candidate.threadId)) {
      continue;
    }
    if (!matchesThreadListFilters(thread, params)) {
      continue;
    }
    supplementalThreads.push(thread);
    existingIds.add(candidate.threadId);
  }

  if (supplementalThreads.length === 0) {
    return payload;
  }

  debugLog("app-server", "supplemented thread/list with indexed subagent threads", {
    supplementalThreadCount: supplementalThreads.length,
    supplementalThreadIds: supplementalThreads
      .map((thread) => normalizeNonEmptyString(thread.id))
      .filter((threadId): threadId is string => threadId !== null),
  });

  const mergedThreads = [...payload.data, ...supplementalThreads].sort((left, right) =>
    compareThreadListRecords(left, right, params.sortKey),
  );
  const limitedThreads =
    params.limit !== null &&
    mergedThreads.length > params.limit &&
    supplementalThreads.length === 0
      ? mergedThreads.slice(0, params.limit)
      : mergedThreads;

  if (arraysReferenceEqual(payload.data, limitedThreads)) {
    return payload;
  }

  return {
    ...payload,
    data: limitedThreads,
  };
}

export async function listIndexedSubagentSessions(
  bridge: ThreadRecordsBridgeContext,
  archived: boolean,
): Promise<SessionThreadIndexRecord[]> {
  const sessionsRoot = join(bridge.getCodexHomePath(), archived ? "archived_sessions" : "sessions");
  const queue = [sessionsRoot];
  const indexedSessions: SessionThreadIndexRecord[] = [];

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
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const indexedSession = await readSessionThreadIndexRecord(bridge, absolutePath);
      if (!indexedSession?.parentThreadId) {
        continue;
      }

      indexedSessions.push(indexedSession);
    }
  }

  return indexedSessions;
}

export async function readSessionThreadIndexRecord(
  bridge: ThreadRecordsBridgeContext,
  sessionPath: string,
): Promise<SessionThreadIndexRecord | null> {
  const normalizedPath = resolve(sessionPath);
  const cached = bridge.sessionThreadIndexCache.get(normalizedPath);
  if (cached) {
    return cached;
  }

  const pending = loadSessionThreadIndexRecord(normalizedPath);
  bridge.sessionThreadIndexCache.set(normalizedPath, pending);
  return pending;
}

export async function readThreadRecordById(
  bridge: ThreadRecordsBridgeContext,
  threadId: string,
): Promise<JsonRecord | null> {
  const normalizedThreadId = normalizeNonEmptyString(threadId);
  if (!normalizedThreadId) {
    return null;
  }

  const cached = bridge.threadRecordReadCache.get(normalizedThreadId);
  if (cached) {
    return cached;
  }

  const pending = threadReadSemaphore.withPermit(async () => {
    for (let attempt = 0; attempt <= THREAD_READ_OVERLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await bridge.sendLocalRequest("thread/read", {
          threadId: normalizedThreadId,
          includeTurns: false,
        });
        if (!isJsonRecord(response) || !isJsonRecord(response.thread)) {
          return null;
        }
        const enrichedThread = await enrichThreadRecord(bridge, response.thread);
        return isJsonRecord(enrichedThread) ? enrichedThread : null;
      } catch (error) {
        if (
          !isOverloadedThreadReadError(error) ||
          attempt >= THREAD_READ_OVERLOAD_RETRY_DELAYS_MS.length
        ) {
          return null;
        }
        await delay(THREAD_READ_OVERLOAD_RETRY_DELAYS_MS[attempt]);
      }
    }

    return null;
  });

  bridge.threadRecordReadCache.set(normalizedThreadId, pending);
  return pending;
}

function isOverloadedThreadReadError(error: unknown): boolean {
  const message = normalizeError(error).message.toLowerCase();
  return message.includes("server overloaded") || message.includes("retry later");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limitedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(
    Array.from({ length: limitedConcurrency }, () => worker()),
  );

  return results;
}

async function loadSessionThreadIndexRecord(
  sessionPath: string,
): Promise<SessionThreadIndexRecord | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(sessionPath, "r");
    const chunks: string[] = [];
    let position = 0;
    let totalBytesRead = 0;

    while (totalBytesRead < 256 * 1024) {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) {
        break;
      }

      totalBytesRead += bytesRead;
      position += bytesRead;

      const chunk = buffer.toString("utf8", 0, bytesRead);
      const newlineIndex = chunk.indexOf("\n");
      if (newlineIndex >= 0) {
        chunks.push(chunk.slice(0, newlineIndex));
        break;
      }

      chunks.push(chunk);
    }

    const firstLine = chunks.join("").trim();
    if (!firstLine) {
      return null;
    }

    return parseSessionThreadIndexRecord(JSON.parse(firstLine));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    debugLog("app-server", "failed to read session thread index record", {
      path: sessionPath,
      error: normalizeError(error).message,
    });
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function loadSessionSubagentMetadata(
  sessionPath: string,
): Promise<SessionSubagentMetadata | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(sessionPath, "r");
    const chunks: string[] = [];
    let position = 0;
    let totalBytesRead = 0;

    while (totalBytesRead < 256 * 1024) {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) {
        break;
      }

      totalBytesRead += bytesRead;
      position += bytesRead;

      const chunk = buffer.toString("utf8", 0, bytesRead);
      const newlineIndex = chunk.indexOf("\n");
      if (newlineIndex >= 0) {
        chunks.push(chunk.slice(0, newlineIndex));
        break;
      }

      chunks.push(chunk);
    }

    const firstLine = chunks.join("").trim();
    if (!firstLine) {
      return null;
    }

    return parseSessionSubagentMetadata(JSON.parse(firstLine));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    debugLog("app-server", "failed to read session subagent metadata", {
      path: sessionPath,
      error: normalizeError(error).message,
    });
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function loadSessionSyntheticCollabCalls(
  sessionPath: string,
): Promise<SessionSyntheticCollabCallRecord[]> {
  try {
    const contents = await readFile(sessionPath, "utf8");
    return parseSessionSyntheticCollabCalls(contents);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    debugLog("app-server", "failed to read session synthetic collab calls", {
      path: sessionPath,
      error: normalizeError(error).message,
    });
    return [];
  }
}
