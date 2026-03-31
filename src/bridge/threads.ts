import type {
  ResolvedSessionSyntheticCollabCallRecord,
  SessionSubagentMetadata,
  SessionSyntheticCollabCallRecord,
  SessionThreadIndexRecord,
  ThreadListRequestParams,
} from "./shared.js";
import type { JsonRecord } from "../core/protocol.js";
import {
  isJsonRecord,
  normalizeInteger,
  normalizeNonEmptyString,
  normalizeNumber,
  normalizePositiveInteger,
} from "./utils.js";

export function parseSessionSubagentMetadata(payload: unknown): SessionSubagentMetadata | null {
  if (!isJsonRecord(payload) || payload.type !== "session_meta" || !isJsonRecord(payload.payload)) {
    return null;
  }

  const metadata = payload.payload;
  const source = isJsonRecord(metadata.source) ? metadata.source : null;
  const subagent = source && isJsonRecord(source.subagent) ? source.subagent : null;
  const threadSpawn = subagent && isJsonRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  const parentThreadId = normalizeNonEmptyString(threadSpawn?.parent_thread_id);
  if (!parentThreadId) {
    return null;
  }

  const agentNickname =
    normalizeNonEmptyString(metadata.agent_nickname) ??
    normalizeNonEmptyString(threadSpawn?.agent_nickname);
  const agentRole =
    normalizeNonEmptyString(metadata.agent_role) ??
    normalizeNonEmptyString(threadSpawn?.agent_role);
  const agentPath = normalizeNonEmptyString(threadSpawn?.agent_path);

  return {
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: parentThreadId,
          depth: normalizeInteger(threadSpawn?.depth),
          agent_path: agentPath,
          agent_nickname: agentNickname,
          agent_role: agentRole,
        },
      },
    },
    agentNickname,
    agentRole,
  };
}

export function parseSessionThreadIndexRecord(payload: unknown): SessionThreadIndexRecord | null {
  if (!isJsonRecord(payload) || payload.type !== "session_meta" || !isJsonRecord(payload.payload)) {
    return null;
  }

  const metadata = payload.payload;
  const threadId = normalizeNonEmptyString(metadata.id);
  if (!threadId) {
    return null;
  }

  const source = isJsonRecord(metadata.source) ? metadata.source : null;
  const subagent = source && isJsonRecord(source.subagent) ? source.subagent : null;
  const threadSpawn = subagent && isJsonRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  const parentThreadId = normalizeNonEmptyString(threadSpawn?.parent_thread_id);
  const timestampText = normalizeNonEmptyString(metadata.timestamp);
  const timestampMs = timestampText ? Date.parse(timestampText) : Number.NaN;

  return {
    threadId,
    parentThreadId,
    timestamp: Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : null,
  };
}

export function parseSessionSyntheticCollabCalls(
  contents: string,
): SessionSyntheticCollabCallRecord[] {
  const pendingCalls = new Map<
    string,
    {
      timestampMs: number | null;
      agentId: string | null;
      agentNickname: string | null;
      agentRole: string | null;
      prompt: string | null;
      model: string | null;
      reasoningEffort: string | null;
      tool: string;
      status: "inProgress" | "completed";
      agentStateStatus: "running" | "completed";
      agentStateMessage: string | null;
      receiverThread: JsonRecord | null;
    }
  >();
  const agentIdToCallIds = new Map<string, string[]>();

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isJsonRecord(entry) || !isJsonRecord(entry.payload)) {
      continue;
    }

    const payload = entry.payload;
    const timestampMs = normalizeTimestampMs(entry.timestamp);

    if (entry.type === "response_item" && payload.type === "function_call") {
      const callId = normalizeNonEmptyString(payload.call_id);
      const functionName = normalizeNonEmptyString(payload.name);
      const argumentsPayload = safeParseJsonString(payload.arguments);
      if (!callId || !functionName || !isJsonRecord(argumentsPayload)) {
        continue;
      }

      if (functionName === "spawn_agent") {
        pendingCalls.set(callId, {
          timestampMs,
          agentId: null,
          agentNickname: null,
          agentRole: normalizeNonEmptyString(argumentsPayload.agent_type),
          prompt: normalizeNonEmptyString(argumentsPayload.message),
          model: normalizeNonEmptyString(argumentsPayload.model),
          reasoningEffort: normalizeNonEmptyString(argumentsPayload.reasoning_effort),
          tool: mapSyntheticCollabToolName(functionName),
          status: "inProgress",
          agentStateStatus: "running",
          agentStateMessage: null,
          receiverThread: null,
        });
        continue;
      }

      if (functionName === "close_agent") {
        const targetAgentId =
          normalizeNonEmptyString(argumentsPayload.id) ??
          normalizeNonEmptyString(argumentsPayload.target);
        if (!targetAgentId) {
          continue;
        }
        for (const callIdForAgent of agentIdToCallIds.get(targetAgentId) ?? []) {
          const pending = pendingCalls.get(callIdForAgent);
          if (!pending) {
            continue;
          }
          pending.status = "completed";
          if (pending.agentStateStatus !== "completed") {
            pending.agentStateStatus = "completed";
          }
        }
      }

      continue;
    }

    if (entry.type === "response_item" && payload.type === "function_call_output") {
      const callId = normalizeNonEmptyString(payload.call_id);
      const pending = callId ? pendingCalls.get(callId) : null;
      if (!callId) {
        continue;
      }

      const outputPayload = safeParseJsonString(payload.output);
      if (pending) {
        const agentId = isJsonRecord(outputPayload)
          ? normalizeNonEmptyString(outputPayload.agent_id) ??
            normalizeNonEmptyString(outputPayload.id) ??
            normalizeNonEmptyString(outputPayload.agent_path)
          : null;
        if (agentId) {
          pending.agentId = agentId;
          pending.agentNickname =
            normalizeNonEmptyString((outputPayload as JsonRecord).nickname) ??
            normalizeNonEmptyString((outputPayload as JsonRecord).agent_nickname) ??
            pending.agentNickname;
          const existing = agentIdToCallIds.get(agentId) ?? [];
          if (!existing.includes(callId)) {
            existing.push(callId);
            agentIdToCallIds.set(agentId, existing);
          }
          continue;
        }
      }

      if (isJsonRecord(outputPayload) && isJsonRecord(outputPayload.status)) {
        for (const [agentId, statusValue] of Object.entries(outputPayload.status)) {
          if (typeof agentId !== "string" || !isJsonRecord(statusValue)) {
            continue;
          }
          for (const callIdForAgent of agentIdToCallIds.get(agentId) ?? []) {
            const collabCall = pendingCalls.get(callIdForAgent);
            if (!collabCall) {
              continue;
            }
            const [agentStateStatus, agentStateMessage] = normalizeAgentState(statusValue);
            collabCall.status = agentStateStatus === "completed" ? "completed" : collabCall.status;
            collabCall.agentStateStatus = agentStateStatus;
            collabCall.agentStateMessage = agentStateMessage;
            if (collabCall.timestampMs === null) {
              collabCall.timestampMs = timestampMs;
            }
          }
        }
      }

      continue;
    }

    if (entry.type !== "response_item" || payload.type !== "message" || payload.role !== "user") {
      continue;
    }

    const notification = extractSubagentNotificationPayload(payload.content);
    const agentId =
      normalizeNonEmptyString(notification?.agent_id) ??
      normalizeNonEmptyString(notification?.agent_path);
    const statusPayload = notification && isJsonRecord(notification.status) ? notification.status : null;
    if (!agentId || !statusPayload) {
      continue;
    }

    for (const callId of agentIdToCallIds.get(agentId) ?? []) {
      const collabCall = pendingCalls.get(callId);
      if (!collabCall) {
        continue;
      }
      const [agentStateStatus, agentStateMessage] = normalizeAgentState(statusPayload);
      collabCall.status = agentStateStatus === "completed" ? "completed" : collabCall.status;
      collabCall.agentStateStatus = agentStateStatus;
      collabCall.agentStateMessage = agentStateMessage;
      if (collabCall.timestampMs === null) {
        collabCall.timestampMs = timestampMs;
      }
    }
  }

  return [...pendingCalls.values()].map((record) => ({
    timestampMs: record.timestampMs,
    agentId: record.agentId,
    agentNickname: record.agentNickname,
    agentRole: record.agentRole,
    prompt: record.prompt,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    tool: record.tool,
    status: record.status,
    agentStateStatus: record.agentStateStatus,
    agentStateMessage: record.agentStateMessage,
    receiverThread: record.receiverThread,
  }));
}

export function injectSyntheticCollabToolCalls(
  turns: unknown[],
  senderThreadId: string,
  collabCalls: readonly ResolvedSessionSyntheticCollabCallRecord[],
): unknown[] {
  if (turns.length === 0 || collabCalls.length === 0) {
    return turns;
  }

  const nextTurns = [...turns];
  let changed = false;

  for (const collabCall of collabCalls) {
    const turnIndex = findBestSyntheticTurnIndex(turns, collabCall.timestampMs);
    if (turnIndex < 0) {
      continue;
    }

    const turn = nextTurns[turnIndex];
    if (!isJsonRecord(turn)) {
      continue;
    }

    const items = Array.isArray(turn.items) ? turn.items : [];
    if (hasSyntheticCollabToolCall(items, collabCall.agentId)) {
      continue;
    }

    nextTurns[turnIndex] = {
      ...turn,
      items: [...items, buildSyntheticCollabToolCall(senderThreadId, collabCall)],
    };
    changed = true;
  }

  return changed ? nextTurns : turns;
}

export function isResolvedSyntheticCollabCall(
  call: SessionSyntheticCollabCallRecord,
): call is ResolvedSessionSyntheticCollabCallRecord {
  return typeof call.agentId === "string" && call.agentId.length > 0;
}

export function normalizeThreadListRequestParams(
  requestParams: unknown,
): ThreadListRequestParams {
  const params = isJsonRecord(requestParams) ? requestParams : null;
  const modelProviders = Array.isArray(params?.modelProviders)
    ? new Set(
        params.modelProviders.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ),
      )
    : null;

  return {
    archived: params?.archived === true,
    limit: normalizePositiveInteger(params?.limit),
    modelProviderSet: modelProviders && modelProviders.size > 0 ? modelProviders : null,
    searchTerm: normalizeNonEmptyString(params?.searchTerm)?.toLowerCase() ?? null,
    sortKey: params?.sortKey === "created_at" ? "created_at" : "updated_at",
  };
}

export function matchesThreadListFilters(
  thread: JsonRecord,
  params: ThreadListRequestParams,
): boolean {
  if (params.modelProviderSet) {
    const modelProvider = normalizeNonEmptyString(thread.modelProvider);
    if (!modelProvider || !params.modelProviderSet.has(modelProvider)) {
      return false;
    }
  }

  if (!params.searchTerm) {
    return true;
  }

  const searchHaystack = [
    normalizeNonEmptyString(thread.id),
    normalizeNonEmptyString(thread.name),
    normalizeNonEmptyString(thread.preview),
    normalizeNonEmptyString(thread.cwd),
    normalizeNonEmptyString(thread.agentNickname),
    normalizeNonEmptyString(thread.agentRole),
  ]
    .filter((value): value is string => value !== null)
    .join("\n")
    .toLowerCase();

  return searchHaystack.includes(params.searchTerm);
}

export function compareThreadListRecords(
  left: unknown,
  right: unknown,
  sortKey: ThreadListRequestParams["sortKey"],
): number {
  const leftRecord = isJsonRecord(left) ? left : null;
  const rightRecord = isJsonRecord(right) ? right : null;
  const leftTimestamp = readThreadListTimestamp(leftRecord, sortKey);
  const rightTimestamp = readThreadListTimestamp(rightRecord, sortKey);
  if (leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }

  const leftId = normalizeNonEmptyString(leftRecord?.id) ?? "";
  const rightId = normalizeNonEmptyString(rightRecord?.id) ?? "";
  return rightId.localeCompare(leftId);
}

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function findBestSyntheticTurnIndex(turns: readonly unknown[], timestampMs: number | null): number {
  if (turns.length === 0) {
    return -1;
  }

  if (timestampMs === null) {
    return turns.length - 1;
  }

  let bestIndex = -1;
  let bestTimestamp = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!isJsonRecord(turn)) {
      continue;
    }

    const turnTimestamp =
      normalizeTimestampMs(turn.turnStartedAtMs) ??
      normalizeTimestampMs(turn.startedAt) ??
      normalizeTimestampMs(turn.createdAt);
    if (turnTimestamp === null || turnTimestamp > timestampMs || turnTimestamp < bestTimestamp) {
      continue;
    }

    bestIndex = index;
    bestTimestamp = turnTimestamp;
  }

  return bestIndex >= 0 ? bestIndex : turns.length - 1;
}

function buildSyntheticCollabToolCall(
  senderThreadId: string,
  collabCall: ResolvedSessionSyntheticCollabCallRecord,
): JsonRecord {
  return {
    id: `pocodex-collab-agent-${collabCall.agentId}`,
    type: "collabAgentToolCall",
    tool: collabCall.tool,
    status: collabCall.status,
    senderThreadId,
    receiverThreadIds: [collabCall.agentId],
    receiverThreads: [
      {
        threadId: collabCall.agentId,
        thread: collabCall.receiverThread,
      },
    ],
    prompt: collabCall.prompt ?? "",
    model: collabCall.model,
    reasoningEffort: collabCall.reasoningEffort,
    agentsStates: {
      [collabCall.agentId]: {
        status: collabCall.agentStateStatus,
        message: collabCall.agentStateMessage,
        nickname: collabCall.agentNickname,
        role: collabCall.agentRole,
      },
    },
  };
}

function hasSyntheticCollabToolCall(items: readonly unknown[], agentId: string): boolean {
  return items.some(
    (item) =>
      isJsonRecord(item) &&
      item.type === "collabAgentToolCall" &&
      Array.isArray(item.receiverThreadIds) &&
      item.receiverThreadIds.includes(agentId),
  );
}

function extractSubagentNotificationPayload(content: unknown): JsonRecord | null {
  if (!Array.isArray(content)) {
    return null;
  }

  for (const item of content) {
    if (!isJsonRecord(item)) {
      continue;
    }

    const text =
      normalizeNonEmptyString(item.text) ??
      normalizeNonEmptyString(item.output_text) ??
      normalizeNonEmptyString(item.input_text);
    if (!text) {
      continue;
    }

    const match = text.match(/<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/i);
    if (!match) {
      continue;
    }

    const payload = safeParseJsonString(match[1]);
    if (isJsonRecord(payload)) {
      return payload;
    }
  }

  return null;
}

function normalizeAgentState(statusPayload: JsonRecord): ["running" | "completed", string | null] {
  const completedMessage = normalizeNonEmptyString(statusPayload.completed);
  if (completedMessage) {
    return ["completed", completedMessage];
  }

  const failedMessage = normalizeNonEmptyString(statusPayload.failed);
  if (failedMessage) {
    return ["completed", failedMessage];
  }

  const runningMessage =
    normalizeNonEmptyString(statusPayload.running) ??
    normalizeNonEmptyString(statusPayload.in_progress);
  if (runningMessage) {
    return ["running", runningMessage];
  }

  return ["completed", null];
}

function mapSyntheticCollabToolName(tool: string): string {
  switch (tool) {
    case "spawn_agent":
      return "spawnAgent";
    case "send_input":
      return "sendInput";
    case "close_agent":
      return "closeAgent";
    case "wait_agent":
      return "wait";
    default:
      return tool;
  }
}

function safeParseJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readThreadListTimestamp(
  record: JsonRecord | null,
  sortKey: ThreadListRequestParams["sortKey"],
): number {
  if (!record) {
    return 0;
  }

  const candidate =
    sortKey === "created_at"
      ? normalizeNumber(record.createdAt)
      : normalizeNumber(record.updatedAt) ?? normalizeNumber(record.createdAt);
  return candidate ?? 0;
}
