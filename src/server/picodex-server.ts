import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import mimeTypes from "mime-types";
import { WebSocket, WebSocketServer } from "ws";

import { debugLog, warnOnceLog } from "../core/debug.js";
import { getUnsupportedBridgeNotice } from "./native-policy.js";
import type {
  JsonRecord,
  BrowserToServerEnvelope,
  PicodexServerOptions,
  ServerToBrowserEnvelope,
} from "../core/protocol.js";
import { routeHostMessage, rewriteRequestIdsForHost } from "../core/request-id.js";

interface BrowserSession {
  id: string;
  socket: WebSocket;
  subscribedWorkers: Set<string>;
  isFocused: boolean;
  terminalSessionIdsByLocalSessionId: Map<string, string>;
}

interface TerminalSessionRoute {
  id: string;
  conversationId: string | null;
  ownerBrowserSessionId: string | null;
  participantOrder: string[];
  localSessionIdsByBrowserSessionId: Map<string, string>;
}

interface PendingBrowserIpcRequest {
  originalRequestId: string;
  targetSessionId: string;
  resolve: (response: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const TERMINAL_CONTROL_MESSAGE_TYPES = new Set([
  "terminal-write",
  "terminal-run-action",
  "terminal-resize",
  "terminal-close",
]);
const TERMINAL_ATTACH_MESSAGE_TYPES = new Set(["terminal-create", "terminal-attach"]);
const TERMINAL_STREAM_MESSAGE_TYPES = new Set(["terminal-data", "terminal-error", "terminal-exit"]);
const TERMINAL_TARGET_BROWSER_SESSION_ID_KEY = "_picodexBrowserSessionId";
const TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY = "_picodexBrowserTerminalSessionId";
const BROWSER_IPC_BROADCAST_MESSAGE_TYPES = new Set([
  "thread-stream-state-changed",
  "thread-queued-followups-changed",
]);
const BROWSER_CROSS_SESSION_BRIDGE_MESSAGE_TYPES = new Set([
  "thread-stream-snapshot-request",
  "thread-stream-resume-request",
]);
const TARGETED_BROWSER_IPC_METHOD_TO_REQUEST_TYPE = new Map<string, string>([
  ["thread-follower-start-turn", "thread-follower-start-turn-request"],
  ["thread-follower-steer-turn", "thread-follower-steer-turn-request"],
  ["thread-follower-interrupt-turn", "thread-follower-interrupt-turn-request"],
  [
    "thread-follower-set-model-and-reasoning",
    "thread-follower-set-model-and-reasoning-request",
  ],
  [
    "thread-follower-set-collaboration-mode",
    "thread-follower-set-collaboration-mode-request",
  ],
  ["thread-follower-edit-last-user-turn", "thread-follower-edit-last-user-turn-request"],
  [
    "thread-follower-command-approval-decision",
    "thread-follower-command-approval-decision-request",
  ],
  [
    "thread-follower-file-approval-decision",
    "thread-follower-file-approval-decision-request",
  ],
  ["thread-follower-submit-user-input", "thread-follower-submit-user-input-request"],
  [
    "thread-follower-set-queued-follow-ups-state",
    "thread-follower-set-queued-follow-ups-state-request",
  ],
  ["thread-role", "thread-role-request"],
]);
const TARGETED_BROWSER_IPC_TIMEOUT_MS = 30_000;

export class PicodexServer {
  private readonly httpServer: HttpServer;
  private readonly wsServer: WebSocketServer;
  private readonly pendingBySocket = new WeakMap<WebSocket, Promise<void>>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly workerSubscriberCounts = new Map<string, number>();
  private readonly terminalSessionRoutes = new Map<string, TerminalSessionRoute>();
  private readonly terminalSessionIdsByConversation = new Map<string, string>();
  private readonly pendingBrowserIpcRequests = new Map<string, PendingBrowserIpcRequest>();
  private indexHtmlPromise?: Promise<string>;

  constructor(private readonly options: PicodexServerOptions) {
    this.httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.wsServer = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.wsServer.on("connection", (socket) => {
      this.handleConnection(socket);
    });

    this.options.relay.on("bridge_message", (message) => {
      this.handleRelayBridgeMessage(message);
    });
    this.options.relay.on("worker_message", (workerName, message) => {
      this.handleRelayWorkerMessage(workerName, message);
    });
    this.options.relay.on("error", (error) => {
      this.broadcast({
        type: "error",
        message: error.message,
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.options.listenPort, this.options.listenHost, () => {
        this.httpServer.off("error", reject);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.socket.close(1000, "shutdown");
    }
    this.sessions.clear();
    this.workerSubscriberCounts.clear();
    this.terminalSessionRoutes.clear();
    this.terminalSessionIdsByConversation.clear();
    this.rejectAllPendingBrowserIpcRequests("Picodex server is shutting down.");

    for (const client of this.wsServer.clients) {
      client.terminate();
    }

    await new Promise<void>((resolvePromise) => {
      this.wsServer.close(() => resolvePromise());
    });

    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.closeIdleConnections?.();
      this.httpServer.closeAllConnections?.();
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  }

  getAddress(): AddressInfo {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Picodex server is not listening on a TCP address");
    }
    return address;
  }

  notifyStylesheetReload(versionTag: string): void {
    this.broadcast({
      type: "css_reload",
      href: `/picodex.css?v=${encodeURIComponent(versionTag)}`,
    });
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${this.options.listenHost}:${this.options.listenPort}`,
    );

    if (url.pathname === "/settings" || url.pathname.startsWith("/settings/")) {
      const redirectUrl = new URL("/", url);
      url.searchParams.forEach((value, key) => {
        if (key !== "initialRoute") {
          redirectUrl.searchParams.set(key, value);
        }
      });
      const initialRoute =
        url.pathname === "/settings" ? "/settings/general-settings" : url.pathname;
      redirectUrl.searchParams.set("initialRoute", initialRoute);
      response.statusCode = 302;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Location", `${redirectUrl.pathname}${redirectUrl.search}`);
      response.end();
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await this.getIndexHtml());
      return;
    }

    if (url.pathname === "/session-check") {
      const authorized = this.isAuthorized(url.searchParams.get("token"));
      response.statusCode = authorized ? 200 : 401;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: authorized }));
      return;
    }

    if (url.pathname === "/picodex.css") {
      try {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/css; charset=utf-8");
        response.end(await this.options.readPicodexStylesheet());
      } catch {
        response.statusCode = 500;
        response.end("Unable to load Picodex stylesheet");
      }
      return;
    }

    if (url.pathname === "/healthz") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/ipc-request") {
      await this.handleIpcRequest(request, response);
      return;
    }

    if (url.pathname === "/workspace-file-download") {
      await this.handleWorkspaceFileDownloadRequest(url, response);
      return;
    }

    const relativePath = url.pathname.replace(/^\/+/, "");
    const absolutePath = resolve(this.options.webviewRoot, relativePath);
    if (!absolutePath.startsWith(`${this.options.webviewRoot}${sep}`)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }

    try {
      const fileBuffer = await readFile(absolutePath);
      response.statusCode = 200;
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.setHeader(
        "Content-Type",
        mimeTypes.lookup(absolutePath) || "application/octet-stream",
      );
      response.end(fileBuffer);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  }

  private async handleWorkspaceFileDownloadRequest(
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.options.relay.resolveWorkspaceFileDownload) {
      response.statusCode = 404;
      response.end("Workspace download is unavailable");
      return;
    }

    if (!this.isAuthorized(url.searchParams.get("token"))) {
      response.statusCode = 401;
      response.setHeader("Cache-Control", "no-store");
      response.end("Unauthorized");
      return;
    }

    const requestedPath = url.searchParams.get("path")?.trim() ?? "";
    if (!requestedPath) {
      response.statusCode = 400;
      response.setHeader("Cache-Control", "no-store");
      response.end("Workspace file path is required");
      return;
    }

    try {
      const target = await this.options.relay.resolveWorkspaceFileDownload(requestedPath);
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", target.mimeType);
      response.setHeader("Content-Length", String(target.size));
      response.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(target.fileName)}`,
      );

      const stream = createReadStream(target.path);
      stream.on("error", () => {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end("Failed to stream workspace file");
          return;
        }
        response.destroy();
      });
      response.on("close", () => {
        stream.destroy();
      });
      stream.pipe(response);
    } catch (error) {
      response.statusCode = 400;
      response.setHeader("Cache-Control", "no-store");
      response.end(error instanceof Error ? error.message : "Failed to prepare workspace download");
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(
      request.url ?? "/",
      `http://${this.options.listenHost}:${this.options.listenPort}`,
    );
    if (url.pathname !== "/session") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!this.isAuthorized(url.searchParams.get("token"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      this.wsServer.emit("connection", upgradedSocket, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    const session: BrowserSession = {
      id: randomUUID(),
      socket,
      subscribedWorkers: new Set(),
      isFocused: true,
      terminalSessionIdsByLocalSessionId: new Map(),
    };
    this.sessions.set(session.id, session);
    debugLog("server", "browser connected", { sessionId: session.id });
    this.broadcastClientStatusChanged("connected", session.id);

    socket.on("message", (data) => {
      const previous = this.pendingBySocket.get(socket) ?? Promise.resolve();
      const next = previous
        .then(() => this.handleSocketMessage(session, String(data)))
        .catch((error) => {
          this.send(socket, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      this.pendingBySocket.set(socket, next);
    });

    socket.on("close", () => {
      debugLog("server", "browser disconnected", { sessionId: session.id });
      if (this.sessions.get(session.id) !== session) {
        return;
      }
      this.cleanupSession(session);
      this.broadcastClientStatusChanged("disconnected", session.id);
    });
  }

  private isAuthorized(requestToken: string | null): boolean {
    return this.options.token.length === 0 || requestToken === this.options.token;
  }

  private async handleSocketMessage(session: BrowserSession, raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as BrowserToServerEnvelope;
    debugLog("server", "browser message", envelope);

    if (this.sessions.get(session.id) !== session) {
      this.send(session.socket, {
        type: "session_revoked",
        reason: "This Picodex session is no longer active.",
      });
      session.socket.close(4001, "inactive");
      return;
    }

    switch (envelope.type) {
      case "bridge_message":
        await this.handleBridgeEnvelope(session, envelope.message);
        break;
      case "worker_subscribe":
        if (!session.subscribedWorkers.has(envelope.workerName)) {
          session.subscribedWorkers.add(envelope.workerName);
          await this.incrementWorkerSubscribers(envelope.workerName);
        }
        break;
      case "worker_unsubscribe":
        if (session.subscribedWorkers.delete(envelope.workerName)) {
          await this.decrementWorkerSubscribers(envelope.workerName);
        }
        break;
      case "worker_message":
        await this.options.relay.sendWorkerMessage(envelope.workerName, envelope.message);
        break;
      case "focus_state":
        session.isFocused = envelope.isFocused;
        this.send(session.socket, {
          type: "bridge_message",
          message: {
            type: "electron-window-focus-changed",
            isFocused: envelope.isFocused,
          },
        });
        break;
      default:
        this.send(session.socket, {
          type: "error",
          message: `Unknown Picodex browser message ${(envelope as { type: string }).type}`,
        });
    }
  }

  private async handleBridgeEnvelope(session: BrowserSession, message: unknown): Promise<void> {
    if (this.tryResolvePendingBrowserIpcRequest(message)) {
      return;
    }

    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message as { type?: unknown }).type === "electron-window-focus-request"
    ) {
      this.send(session.socket, {
        type: "bridge_message",
        message: {
          type: "electron-window-focus-changed",
          isFocused: session.isFocused,
        },
      });
      return;
    }

    if (isTerminalBridgeMessage(message)) {
      await this.handleTerminalBridgeEnvelope(session, message);
      return;
    }

    if (isBrowserIpcBroadcastMessage(message)) {
      this.broadcastBrowserIpcMessage(session.id, message, {
        includeSourceSession: false,
      });
      return;
    }

    if (isCrossSessionBridgeMessage(message)) {
      this.broadcastCrossSessionBridgeMessage(session.id, message);
      return;
    }

    const blockedNotice = getUnsupportedBridgeNotice(message);
    if (blockedNotice) {
      debugLog("server", "blocked browser bridge message", {
        message,
        blockedNotice,
      });
      if (isJsonRecord(message) && typeof message.type === "string") {
        warnOnceLog(
          "server",
          `blocked-browser-bridge:${message.type}`,
          "blocked browser bridge message",
          {
            type: message.type,
            blockedNotice,
          },
        );
      }
      // this.send(session.socket, {
      //   type: "client_notice",
      //   message: blockedNotice,
      // });
      return;
    }

    const rewrittenMessage = rewriteRequestIdsForHost(session.id, message);
    debugLog("server", "forwarding bridge message to relay", rewrittenMessage);
    await this.options.relay.forwardBridgeMessage(rewrittenMessage);
  }

  private async handleIpcRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rawBody = await readRequestBody(request);
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: "",
          type: "response",
          resultType: "error",
          error: "Invalid JSON body.",
        }),
      );
      return;
    }

    try {
      if (isTargetedBrowserIpcRequestPayload(payload)) {
        const result = await this.handleTargetedBrowserIpcRequest(payload);
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(result));
        return;
      }

      if (!this.options.relay.handleIpcRequest) {
        response.statusCode = 501;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(
          JSON.stringify({
            requestId: extractRequestId(payload),
            type: "response",
            resultType: "error",
            error: "IPC requests are not supported by the active host bridge.",
          }),
        );
        return;
      }

      const result = await this.options.relay.handleIpcRequest(payload);
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: extractRequestId(payload),
          type: "response",
          resultType: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private handleRelayBridgeMessage(message: unknown): void {
    debugLog("server", "relay bridge message", message);
    const routed = routeHostMessage(message);
    if (!routed.deliver || !routed.message) {
      debugLog("server", "dropped relay bridge message", routed);
      return;
    }

    const bridgeMessage = routed.message;
    if (routed.sessionId) {
      this.sendBridgeMessageToSession(routed.sessionId, bridgeMessage);
      return;
    }

    if (!isJsonRecord(bridgeMessage) || typeof bridgeMessage.type !== "string") {
      this.broadcast({
        type: "bridge_message",
        message: bridgeMessage,
      });
      return;
    }

    const typedBridgeMessage = bridgeMessage as JsonRecord & { type: string };

    if (this.handleTargetedTerminalRelayMessage(typedBridgeMessage)) {
      return;
    }

    if (this.handleTerminalStreamRelayMessage(typedBridgeMessage)) {
      return;
    }

    this.broadcast({
      type: "bridge_message",
      message: stripInternalBridgeFields(typedBridgeMessage),
    });
  }

  private handleRelayWorkerMessage(workerName: string, message: unknown): void {
    debugLog("server", "relay worker message", { workerName, message });
    for (const session of this.sessions.values()) {
      if (!session.subscribedWorkers.has(workerName)) {
        continue;
      }
      this.send(session.socket, {
        type: "worker_message",
        workerName,
        message,
      });
    }
  }

  private async handleTerminalBridgeEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    if (TERMINAL_ATTACH_MESSAGE_TYPES.has(message.type)) {
      await this.handleTerminalAttachEnvelope(session, message);
      return;
    }

    if (TERMINAL_CONTROL_MESSAGE_TYPES.has(message.type)) {
      await this.handleTerminalControlEnvelope(session, message);
      return;
    }

    await this.options.relay.forwardBridgeMessage(message);
  }

  private async handleTerminalAttachEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    const requestedLocalSessionId =
      readNonEmptyString(message.sessionId) ?? `picodex-terminal:${session.id}:${randomUUID()}`;
    const conversationId = readNonEmptyString(message.conversationId);
    const canonicalSessionId =
      session.terminalSessionIdsByLocalSessionId.get(requestedLocalSessionId) ??
      (conversationId ? this.terminalSessionIdsByConversation.get(conversationId) : null) ??
      requestedLocalSessionId;

    const route = this.ensureTerminalRoute(canonicalSessionId, conversationId);
    this.attachBrowserToTerminal(route, session, requestedLocalSessionId);

    await this.options.relay.forwardBridgeMessage({
      ...message,
      sessionId: canonicalSessionId,
      [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: session.id,
      [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: requestedLocalSessionId,
    });
  }

  private async handleTerminalControlEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    const requestedLocalSessionId = readNonEmptyString(message.sessionId);
    if (!requestedLocalSessionId) {
      return;
    }

    const canonicalSessionId =
      session.terminalSessionIdsByLocalSessionId.get(requestedLocalSessionId);
    if (!canonicalSessionId) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Terminal session is not available.",
      );
      return;
    }

    const route = this.terminalSessionRoutes.get(canonicalSessionId);
    if (!route) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Terminal session is not available.",
      );
      return;
    }

    this.refreshTerminalOwner(route);
    if (route.ownerBrowserSessionId !== session.id) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Another browser controls this terminal.",
      );
      return;
    }

    await this.options.relay.forwardBridgeMessage({
      ...message,
      sessionId: canonicalSessionId,
      [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: session.id,
      [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: requestedLocalSessionId,
    });
  }

  private ensureTerminalRoute(
    terminalSessionId: string,
    conversationId: string | null,
  ): TerminalSessionRoute {
    let route = this.terminalSessionRoutes.get(terminalSessionId);
    if (!route) {
      route = {
        id: terminalSessionId,
        conversationId,
        ownerBrowserSessionId: null,
        participantOrder: [],
        localSessionIdsByBrowserSessionId: new Map(),
      };
      this.terminalSessionRoutes.set(terminalSessionId, route);
    }

    if (conversationId) {
      route.conversationId = conversationId;
      this.terminalSessionIdsByConversation.set(conversationId, terminalSessionId);
    }

    return route;
  }

  private attachBrowserToTerminal(
    route: TerminalSessionRoute,
    session: BrowserSession,
    localSessionId: string,
  ): void {
    const previousLocalSessionId = route.localSessionIdsByBrowserSessionId.get(session.id);
    if (previousLocalSessionId && previousLocalSessionId !== localSessionId) {
      session.terminalSessionIdsByLocalSessionId.delete(previousLocalSessionId);
    }

    route.localSessionIdsByBrowserSessionId.set(session.id, localSessionId);
    session.terminalSessionIdsByLocalSessionId.set(localSessionId, route.id);
    if (!route.participantOrder.includes(session.id)) {
      route.participantOrder.push(session.id);
    }
    if (!route.ownerBrowserSessionId) {
      route.ownerBrowserSessionId = session.id;
    }
  }

  private handleTargetedTerminalRelayMessage(message: JsonRecord & { type: string }): boolean {
    const targetBrowserSessionId = readNonEmptyString(
      message[TERMINAL_TARGET_BROWSER_SESSION_ID_KEY],
    );
    if (!targetBrowserSessionId) {
      return false;
    }

    this.sendBridgeMessageToSession(targetBrowserSessionId, stripInternalBridgeFields(message));
    return true;
  }

  private handleTerminalStreamRelayMessage(message: JsonRecord & { type: string }): boolean {
    if (!TERMINAL_STREAM_MESSAGE_TYPES.has(message.type)) {
      return false;
    }

    const canonicalSessionId = readNonEmptyString(message.sessionId);
    if (!canonicalSessionId) {
      return false;
    }

    const route = this.terminalSessionRoutes.get(canonicalSessionId);
    if (!route) {
      return false;
    }

    for (const [browserSessionId, localSessionId] of route.localSessionIdsByBrowserSessionId) {
      this.sendBridgeMessageToSession(browserSessionId, {
        ...stripInternalBridgeFields(message),
        sessionId: localSessionId,
      });
    }

    if (message.type === "terminal-exit") {
      this.deleteTerminalRoute(route);
    }

    return true;
  }

  private sendBridgeMessageToSession(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.send(session.socket, {
      type: "bridge_message",
      message,
    });
  }

  private sendTerminalError(
    browserSessionId: string,
    localTerminalSessionId: string,
    message: string,
  ): void {
    this.sendBridgeMessageToSession(browserSessionId, {
      type: "terminal-error",
      sessionId: localTerminalSessionId,
      message,
    });
  }

  private async incrementWorkerSubscribers(workerName: string): Promise<void> {
    const count = this.workerSubscriberCounts.get(workerName) ?? 0;
    if (count === 0) {
      await this.options.relay.subscribeWorker(workerName);
    }
    this.workerSubscriberCounts.set(workerName, count + 1);
  }

  private async decrementWorkerSubscribers(workerName: string): Promise<void> {
    const count = this.workerSubscriberCounts.get(workerName) ?? 0;
    if (count <= 1) {
      this.workerSubscriberCounts.delete(workerName);
      if (count === 1) {
        await this.options.relay.unsubscribeWorker(workerName);
      }
      return;
    }

    this.workerSubscriberCounts.set(workerName, count - 1);
  }

  private cleanupSession(session: BrowserSession): void {
    this.sessions.delete(session.id);
    this.rejectPendingBrowserIpcRequestsForSession(
      session.id,
      "The target browser session disconnected before replying.",
    );
    for (const workerName of session.subscribedWorkers) {
      void this.decrementWorkerSubscribers(workerName);
    }

    for (const [localSessionId, terminalSessionId] of session.terminalSessionIdsByLocalSessionId) {
      session.terminalSessionIdsByLocalSessionId.delete(localSessionId);
      this.detachBrowserFromTerminal(terminalSessionId, session.id);
    }
  }

  private detachBrowserFromTerminal(terminalSessionId: string, browserSessionId: string): void {
    const route = this.terminalSessionRoutes.get(terminalSessionId);
    if (!route) {
      return;
    }

    route.localSessionIdsByBrowserSessionId.delete(browserSessionId);
    route.participantOrder = route.participantOrder.filter(
      (sessionId) => sessionId !== browserSessionId,
    );

    if (route.ownerBrowserSessionId === browserSessionId) {
      route.ownerBrowserSessionId = route.participantOrder[0] ?? null;
    }

    if (route.localSessionIdsByBrowserSessionId.size === 0) {
      this.deleteTerminalRoute(route);
    }
  }

  private deleteTerminalRoute(route: TerminalSessionRoute): void {
    this.terminalSessionRoutes.delete(route.id);
    if (
      route.conversationId &&
      this.terminalSessionIdsByConversation.get(route.conversationId) === route.id
    ) {
      this.terminalSessionIdsByConversation.delete(route.conversationId);
    }

    for (const [browserSessionId, localSessionId] of route.localSessionIdsByBrowserSessionId) {
      const session = this.sessions.get(browserSessionId);
      session?.terminalSessionIdsByLocalSessionId.delete(localSessionId);
    }
  }

  private refreshTerminalOwner(route: TerminalSessionRoute): void {
    if (route.ownerBrowserSessionId && this.sessions.has(route.ownerBrowserSessionId)) {
      return;
    }

    route.participantOrder = route.participantOrder.filter((sessionId) => {
      const session = this.sessions.get(sessionId);
      return session ? route.localSessionIdsByBrowserSessionId.has(session.id) : false;
    });
    route.ownerBrowserSessionId = route.participantOrder[0] ?? null;
  }

  private broadcast(
    envelope: ServerToBrowserEnvelope,
    excludeSessionId: string | null = null,
  ): void {
    for (const session of this.sessions.values()) {
      if (excludeSessionId && session.id === excludeSessionId) {
        continue;
      }
      this.send(session.socket, envelope);
    }
  }

  private broadcastBrowserIpcMessage(
    sourceClientId: string,
    message: JsonRecord & { type: string },
    options: { includeSourceSession?: boolean } = {},
  ): void {
    const { type, version, ...params } = stripInternalBridgeFields(message);
    const ipcBroadcastMessage: JsonRecord = {
      type: "ipc-broadcast",
      method: type,
      params,
      sourceClientId,
    };

    if (typeof version === "number") {
      ipcBroadcastMessage.version = version;
    }

    this.broadcast(
      {
        type: "bridge_message",
        message: ipcBroadcastMessage,
      },
      options.includeSourceSession === false ? sourceClientId : null,
    );
  }

  private broadcastCrossSessionBridgeMessage(
    sourceSessionId: string,
    message: JsonRecord & { type: string },
  ): void {
    const hostId =
      readNonEmptyString(message.hostId) ??
      (isJsonRecord(message.params) ? readNonEmptyString(message.params.hostId) : null) ??
      "local";

    this.broadcast(
      {
        type: "bridge_message",
        message: {
          ...stripInternalBridgeFields(message),
          hostId,
        },
      },
      sourceSessionId,
    );
  }

  private broadcastClientStatusChanged(
    status: "connected" | "disconnected",
    sourceSessionId: string,
  ): void {
    this.broadcast(
      {
        type: "bridge_message",
        message: {
          type: "ipc-broadcast",
          method: "client-status-changed",
          params: {
            status,
            hostId: "local",
          },
          sourceClientId: sourceSessionId,
        },
      },
      sourceSessionId,
    );
  }

  private send(socket: WebSocket, envelope: ServerToBrowserEnvelope): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(envelope));
  }

  private getIndexHtml(): Promise<string> {
    if (!this.indexHtmlPromise) {
      this.indexHtmlPromise = this.options.renderIndexHtml();
    }
    return this.indexHtmlPromise;
  }

  private async handleTargetedBrowserIpcRequest(
    payload: JsonRecord & {
      requestId: string;
      method: string;
      targetClientId: string;
    },
  ): Promise<unknown> {
    const requestType = TARGETED_BROWSER_IPC_METHOD_TO_REQUEST_TYPE.get(payload.method);
    if (!requestType) {
      return buildIpcErrorResponse(
        payload.requestId,
        `IPC method "${payload.method}" does not support targetClientId routing.`,
      );
    }

    const targetSession = this.sessions.get(payload.targetClientId);
    if (!targetSession) {
      return buildIpcErrorResponse(
        payload.requestId,
        "The target browser session is not connected.",
      );
    }

    const internalRequestId = `picodex-browser-ipc:${randomUUID()}`;
    const responsePromise = new Promise<unknown>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingBrowserIpcRequests.delete(internalRequestId);
        resolve(
          buildIpcErrorResponse(
            payload.requestId,
            `Timed out waiting for "${payload.method}" response from the target browser session.`,
          ),
        );
      }, TARGETED_BROWSER_IPC_TIMEOUT_MS);

      this.pendingBrowserIpcRequests.set(internalRequestId, {
        originalRequestId: payload.requestId,
        targetSessionId: targetSession.id,
        resolve,
        timeout,
      });
    });

    this.sendBridgeMessageToSession(targetSession.id, buildTargetedBrowserIpcRequestMessage(
      payload,
      requestType,
      internalRequestId,
    ));

    return responsePromise;
  }

  private tryResolvePendingBrowserIpcRequest(message: unknown): boolean {
    if (
      !isJsonRecord(message) ||
      typeof message.type !== "string" ||
      typeof message.requestId !== "string"
    ) {
      return false;
    }

    const typedMessage = message as JsonRecord & { type: string; requestId: string };
    const pending = this.pendingBrowserIpcRequests.get(typedMessage.requestId);
    if (!pending) {
      return false;
    }

    this.pendingBrowserIpcRequests.delete(typedMessage.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(resolveTargetedBrowserIpcResponse(typedMessage, pending.originalRequestId));
    return true;
  }

  private rejectPendingBrowserIpcRequestsForSession(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingBrowserIpcRequests) {
      if (pending.targetSessionId !== sessionId) {
        continue;
      }

      this.pendingBrowserIpcRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(buildIpcErrorResponse(pending.originalRequestId, reason));
    }
  }

  private rejectAllPendingBrowserIpcRequests(reason: string): void {
    for (const [requestId, pending] of this.pendingBrowserIpcRequests) {
      this.pendingBrowserIpcRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(buildIpcErrorResponse(pending.originalRequestId, reason));
    }
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractRequestId(payload: unknown): string {
  return typeof payload === "object" &&
    payload !== null &&
    "requestId" in payload &&
    typeof payload.requestId === "string"
    ? payload.requestId
    : "";
}

function buildIpcSuccessResponse(requestId: string, result: unknown): {
  requestId: string;
  type: "response";
  resultType: "success";
  result: unknown;
} {
  return {
    requestId,
    type: "response",
    resultType: "success",
    result,
  };
}

function buildIpcErrorResponse(requestId: string, error: string): {
  requestId: string;
  type: "response";
  resultType: "error";
  error: string;
} {
  return {
    requestId,
    type: "response",
    resultType: "error",
    error,
  };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function isTargetedBrowserIpcRequestPayload(
  payload: unknown,
): payload is JsonRecord & {
  requestId: string;
  method: string;
  targetClientId: string;
} {
  return (
    isJsonRecord(payload) &&
    typeof payload.requestId === "string" &&
    typeof payload.method === "string" &&
    typeof payload.targetClientId === "string" &&
    payload.targetClientId.trim().length > 0
  );
}

function isTerminalBridgeMessage(message: unknown): message is JsonRecord & { type: string } {
  return (
    isJsonRecord(message) &&
    typeof message.type === "string" &&
    (TERMINAL_ATTACH_MESSAGE_TYPES.has(message.type) ||
      TERMINAL_CONTROL_MESSAGE_TYPES.has(message.type))
  );
}

function isBrowserIpcBroadcastMessage(message: unknown): message is JsonRecord & { type: string } {
  return (
    isJsonRecord(message) &&
    typeof message.type === "string" &&
    BROWSER_IPC_BROADCAST_MESSAGE_TYPES.has(message.type)
  );
}

function isCrossSessionBridgeMessage(message: unknown): message is JsonRecord & { type: string } {
  return (
    isJsonRecord(message) &&
    typeof message.type === "string" &&
    BROWSER_CROSS_SESSION_BRIDGE_MESSAGE_TYPES.has(message.type)
  );
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripInternalBridgeFields(message: JsonRecord): JsonRecord {
  const {
    [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: _browserSessionId,
    [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: _browserTerminalSessionId,
    ...rest
  } = message;
  return rest;
}

function buildTargetedBrowserIpcRequestMessage(
  payload: JsonRecord & {
    method: string;
    requestId: string;
    targetClientId: string;
  },
  requestType: string,
  internalRequestId: string,
): JsonRecord {
  const hostId =
    readNonEmptyString(payload.hostId) ??
    (isJsonRecord(payload.params) ? readNonEmptyString(payload.params.hostId) : null) ??
    "local";

  if (requestType === "thread-role-request") {
    const conversationId =
      readNonEmptyString(payload.conversationId) ??
      (isJsonRecord(payload.params) ? readNonEmptyString(payload.params.conversationId) : null);
    return {
      type: requestType,
      requestId: internalRequestId,
      hostId,
      ...(conversationId ? { conversationId } : {}),
    };
  }

  return {
    type: requestType,
    requestId: internalRequestId,
    hostId,
    params: payload.params,
  };
}

function resolveTargetedBrowserIpcResponse(
  message: JsonRecord & { type: string; requestId: string },
  requestId: string,
) {
  const error = readNonEmptyString(message.error);
  if (error) {
    return buildIpcErrorResponse(requestId, error);
  }

  if ("result" in message) {
    return buildIpcSuccessResponse(requestId, message.result);
  }

  if (message.type === "thread-role-response") {
    return buildIpcSuccessResponse(requestId, {
      role: readNonEmptyString(message.role) ?? "follower",
    });
  }

  return buildIpcErrorResponse(
    requestId,
    `Invalid "${message.type}" payload from target browser session.`,
  );
}
