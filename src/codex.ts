/** Foreground Telegram bridge for a Telex-owned Codex app-server thread. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, pickBot, type Bot } from "./config.ts";
import { fileInbox, scopedInbox } from "./inbox.ts";
import { statePath, ownerOf, release, repoOf, touch, withStateLock } from "./registry.ts";
import { sessionFor, type BotSession, type Incoming } from "./telegram.ts";
import { deliveredReceipt, markExpired, receipt } from "./ask.ts";
import { processStart } from "./wake.ts";
import { fileAnswers } from "./answers.ts";
import { fileRoutes, type RouteRegistration } from "./routes.ts";
import { announceSession, finishSession, sessionIdentity, sessionProcessAlive } from "./lifecycle.ts";

type RpcMessage = { id?: number; method?: string; params?: any; result?: any; error?: { code?: number; message: string } };
type Outgoing = { turnId: string; messages: Incoming[]; text?: string };
type Saved = { threadId: string; project: string; bot: string; chatId?: number | string; routeId?: string;
  route?: RouteRegistration; pid?: number; start?: string; disabled?: boolean; outbox?: Outgoing[] };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export class CodexRejection extends Error {}
const managedRouteId = (project: string, threadId: string) => `codex:${createHash("sha256").update(`${resolve(project)}:${threadId}`).digest("hex")}`;
const bridgeInstructions = "This is a Telex-managed Codex thread. Telex forwards final answers to Telegram. Use the Telex send_to_user tool with options for clickable choices or expect_text for a typed answer, never both. With neither, it sends a notification. Supply this thread's project_path, agent codex and interval_seconds when the tool requests identity. Await the tool result; a timeout means the user is unavailable. This managed bridge handles incoming Telegram messages; heartbeat and host hooks do not collect them. Command/file approvals remain declined by the bridge.";

export const codexStatePath = (project = process.cwd(), bot = "") =>
  join(dirname(statePath()), `codex-${createHash("sha256").update(`${resolve(project)}:${bot}`).digest("hex").slice(0, 16)}.json`);

export function readCodexState(path: string): Saved | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as Saved; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
}

/** The stdio transport has one owner, so no desktop thread can be selected by accident. */
export class CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  onEvent?: (message: RpcMessage) => void;
  onClose?: (error: Error) => void;
  private closed = false;

  constructor(command = "codex", args = ["app-server", "-c", 'plugins."telex@telex".enabled=false'], state?: string, botName?: string) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TELEX_CODEX_BRIDGE: "1", ...(state ? { TELEX_CODEX_STATE: state } : {}), ...(botName ? { TELEX_BOT: botName } : {}) },
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
          this.send({ id: message.id, result: { decision: "decline" } });
        } else {
          this.send({ id: message.id, error: { code: -32000, message: "Telex cannot answer this Codex request" } });
        }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new CodexRejection(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) this.onEvent?.(message);
    });
    this.child.on("error", (error) => this.close(error));
    this.child.on("exit", (code) => this.close(new Error(`Codex app-server exited (${code ?? "signal"})`)));
    this.child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  }

  private send(message: RpcMessage) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }

  request(method: string, params: object = {}, timeout = 15_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is disconnected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; delivery may be pending`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "telex", title: "Telex", version: "0.8.0" } });
    this.send({ method: "initialized", params: {} });
  }

  stop() {
    this.child.stdin.end();
    this.child.kill();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  private close(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.onClose?.(error);
  }
}

export function deliveryMethod(status: string, activeTurnId?: string): "turn/start" | "turn/steer" {
  if (status === "idle") return "turn/start";
  if (status === "active" && activeTurnId) return "turn/steer";
  throw new Error(`Codex thread is ${status}; delivery waits until it is available`);
}

function save(path: string, value: Saved) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function binding(name?: string) {
  const selected = pickBot(loadConfig(), name);
  const botKey = createHash("sha256").update(selected.bot.token).digest("hex");
  const project = resolve(process.cwd());
  const path = codexStatePath(project, botKey);
  const legacy = join(dirname(statePath()), `codex-${createHash("sha256").update(`${repoOf(project)}:${botKey}`).digest("hex").slice(0, 16)}.json`);
  const source = !existsSync(path) && existsSync(legacy) ? legacy : path;
  const state = readCodexState(source);
  if (state && (resolve(state.project) !== project || state.bot !== botKey || state.chatId !== undefined && String(state.chatId) !== String(selected.bot.chatId))) {
    // A legacy common-repository file may belong to another worktree; never inherit its thread.
    if (source === path) throw new Error(`Codex bridge binding differs: ${path}`);
    return { ...selected, botKey, path, project, state: undefined };
  }
  return { ...selected, botKey, path, project, state };
}

export function codexStatus(name?: string) {
  const { path, state } = binding(name);
  const running = !!state?.pid && sessionProcessAlive({ pid: state.pid, processStart: state.start });
  return { path, state, running };
}

function savedRoute(state: Saved | undefined, bot: Bot): RouteRegistration {
  if (!state?.routeId || state.routeId !== managedRouteId(state.project, state.threadId) || !state.route || state.route.id !== state.routeId || state.chatId === undefined ||
    String(state.chatId) !== String(bot.chatId) || String(state.route.chatId) !== String(bot.chatId) ||
    resolve(state.route.worktree) !== resolve(state.project)) {
    throw new Error("legacy Codex delivery has no isolated route; inspect its saved outbox/inbox before resuming or recovering delivery");
  }
  return state.route;
}

export function disableCodex(name?: string) {
  const { path, state } = codexStatus(name);
  if (!state) return false;
  save(path, { ...state, disabled: true });
  return true;
}

export function pendingCodex(name?: string) {
  const { bot, botKey, state } = binding(name);
  if (!state) return { claims: [], replies: [] };
  const route = savedRoute(state, bot);
  const claims = scopedInbox(fileInbox(), `${botKey}:${route.id}`).claimed(String(bot.chatId)).filter((m) => m.wake_claim?.startsWith("codex:"));
  return { claims, replies: state.outbox ?? [] };
}

export async function recoverCodex(id: number, retry: boolean, name?: string) {
  const { bot, botKey, path, state } = binding(name);
  if (state?.pid && sessionProcessAlive({ pid: state.pid, processStart: state.start })) throw new Error("disable the Codex bridge and inspect its thread before recovery");
  const route = savedRoute(state, bot);
  const session = sessionFor(bot.token, route.id);
  // Recovery identifies the original thread without making this short-lived CLI a destination.
  session.setRoute(fileRoutes(bot.token), { ...route, expiresAt: Date.now() - 1 });
  const store = scopedInbox(fileInbox(), `${botKey}:${route.id}`);
  session.setInboxStore(store);
  const reply = state?.outbox?.find((entry) => entry.messages.some((m) => m.message_id === id));
  if (reply) {
    if (retry && reply.text) await session.api("sendMessage", { chat_id: bot.chatId, text: reply.text });
    for (const entry of reply.messages) {
      const claimed = store.claimed(String(bot.chatId)).find((m) => m.message_id === entry.message_id);
      if (retry && !reply.text) {
        if (claimed) store.resolve(String(bot.chatId), entry.message_id, true);
        else store.push(String(bot.chatId), entry);
      } else if (claimed?.wake_claim) session.ackWake(bot.chatId, claimed.wake_claim);
    }
    save(path, { ...state!, outbox: state!.outbox!.filter((entry) => entry !== reply) });
    return;
  }
  const message = store.claimed(String(bot.chatId)).find((m) => m.message_id === id && m.wake_claim?.startsWith("codex:"));
  if (!message) throw new Error(`no pending Codex delivery for message ${id}`);
  store.resolve(String(bot.chatId), id, retry);
  if (message.receipt_id) await session.api("editMessageText", {
    chat_id: bot.chatId, message_id: message.receipt_id,
    text: retry ? "🕦 <i>Held for the agent's next check-in.</i>" : "📬 <i>Delivered to the agent.</i>",
    parse_mode: "HTML",
  }).catch(() => {});
}

export async function runCodex(name?: string) {
  const config = loadConfig();
  const { bot, name: botName, botKey, path, project, state: old } = binding(name);
  if (!bot.allowFrom?.length) throw new Error("Codex bridge requires a nonempty --allow sender list");
  if (old?.pid && sessionProcessAlive({ pid: old.pid, processStart: old.start })) throw new Error("Codex bridge is already running here");
  const sessionId = `codex-bridge:${process.pid}:${randomUUID()}:${botKey}`;
  let stopped = false;
  let threadId = "";
  let currentTurnId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let sending = false;
  let session: BotSession;
  let store: ReturnType<typeof scopedInbox>;
  let route: RouteRegistration;
  let start: string | undefined;
  try { start = processStart(process.pid); } catch { /* PID-only on non-Linux hosts */ }
  const lifecycleId = `${sessionId}:${start ?? "process"}`;
  let lifecycleStarted = false;
  let cleanup: Promise<void> | undefined;
  const poller = sessionFor(bot.token);
  poller.setAnswerStore(fileAnswers(bot.token));
  const routes = fileRoutes(bot.token);
  poller.setRouteStore(routes, (destination, message) => {
    const inbox = scopedInbox(fileInbox(), `${botKey}:${destination.id}`);
    inbox.push(String(destination.chatId), message, Date.now() + config.queueExpirySeconds * 1000);
    const client = sessionFor(bot.token, destination.id);
    client.setRoute(routes, destination);
    client.setInboxStore(inbox);
    void receipt(client, destination.chatId, message).then(() => { if (destination.id === route?.id) wake(); }).catch(report);
  });
  const claimPolling = () => {
    poller.setPollingOwner(ownerOf(botKey) === sessionId);
    poller.listen();
  };
  const rpc = new CodexRpc("codex", ["app-server", "-c", 'plugins."telex@telex".enabled=false',
    "-c", `mcp_servers.telex.command=${JSON.stringify(process.execPath)}`,
    "-c", `mcp_servers.telex.args=${JSON.stringify([fileURLToPath(new URL("./index.js", import.meta.url))])}`,
    "-c", "mcp_servers.telex.enabled=true",
    ...Object.entries({ TELEX_CODEX_BRIDGE: "1", TELEX_CODEX_STATE: path, TELEX_BOT: botName,
      ...Object.fromEntries(["TELEX_STATE", "TELEX_CONFIG", "TELEX_INBOX", "TELEX_PROJECT_CONFIG"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])) })
      .flatMap(([key, value]) => ["-c", `mcp_servers.telex.env.${key}=${JSON.stringify(value)}`]),
  ], path, botName);
  const report = (error: unknown) => { process.stderr.write(`telex: ${(error as Error).message}\n`); };
  const replies = new Map<string, string>();
  const completed = new Set<string>();
  const forwarding = new Set<string>();
  const outbox = () => readCodexState(path)?.outbox ?? [];
  const setOutbox = (items: Outgoing[]) => {
    const state = readCodexState(path);
    if (state) save(path, { ...state, outbox: items });
  };
  const wake = () => void pump().catch((err) => process.stderr.write(`telex: Codex delivery: ${(err as Error).message}\n`));

  async function pump() {
    if (sending || stopped || !threadId) return;
    sending = true;
    try {
      const claimed = store.claimed(String(bot.chatId)).find((m) => m.wake_claim?.startsWith("codex:"));
      if (claimed) return; // ambiguous previous submission needs explicit recovery
      const message = session.claimForWake(bot.chatId, `codex:${Date.now()}:${process.pid}`, () => true);
      if (!message) return;
      const id = store.claimed(String(bot.chatId)).find((m) => m.message_id === message.message_id)?.wake_claim;
      if (!id) return;
      const input = [{ type: "text", text: `Telegram message (${id}):\n${message.text}` }];
      let attempted = false;
      try {
        const read = await rpc.request("thread/read", { threadId });
        const status = read.thread?.status?.type;
        const method = deliveryMethod(status, currentTurnId);
        attempted = true;
        const result = await rpc.request(method, { threadId, input, ...(method === "turn/steer" ? { expectedTurnId: currentTurnId } : {}) });
        const turnId = method === "turn/steer" ? result.turnId : result.turn?.id;
        if (!turnId) throw new Error("Codex accepted delivery without a turn id");
        currentTurnId = turnId;
        const items = outbox();
        const entry = items.find((item) => item.turnId === turnId);
        if (entry) entry.messages.push(message);
        else items.push({ turnId, messages: [message] });
        setOutbox(items);
        const acked = session.ackWake(bot.chatId, id);
        if (acked) await deliveredReceipt(session, bot.chatId, acked);
        if (completed.has(turnId)) await forward(turnId);
      } catch (err) {
        if (!attempted || err instanceof CodexRejection) {
          store.resolve(String(bot.chatId), message.message_id, true);
        } else {
          // A request may have reached Codex before the connection failed. Keep the claim, never replay blindly.
          process.stderr.write(`telex: Codex delivery ${message.message_id} pending: ${(err as Error).message}\n`);
        }
      }
    } finally { sending = false; }
  }

  async function forward(turnId: string) {
    if (forwarding.has(turnId)) return;
    const entry = outbox().find((item) => item.turnId === turnId);
    if (!entry) return;
    forwarding.add(turnId);
    try {
      const text = replies.get(turnId) ?? entry.text;
      if (!text) return;
      entry.text = text;
      setOutbox(outbox().map((item) => item.turnId === turnId ? entry : item));
      await session.api("sendMessage", { chat_id: bot.chatId, text });
      setOutbox(outbox().filter((item) => item.turnId !== turnId));
      replies.delete(turnId);
      wake();
    } finally { forwarding.delete(turnId); }
  }

  rpc.onEvent = (event) => {
    const { method, params } = event;
    if (method === "turn/started" && params?.threadId === threadId) currentTurnId = params.turn?.id;
    if (method === "item/completed" && params?.threadId === threadId && params?.item?.type === "agentMessage" && params.item.phase !== "commentary") {
      replies.set(params.turnId, params.item.text);
    }
    if (method === "turn/completed" && params?.threadId === threadId) {
      if (currentTurnId === params.turn.id) currentTurnId = undefined;
      completed.add(params.turn.id);
      if (!replies.has(params.turn.id)) replies.set(params.turn.id,
        params.turn.error?.message ? `Codex turn failed: ${params.turn.error.message}` : "Codex completed without a final reply.");
      void forward(params.turn.id).catch((err) => process.stderr.write(`telex: reply failed: ${(err as Error).message}\n`));
    }
  };
  rpc.onClose = (error) => { if (!stopped) { report(error); void stop().catch(report); } };

  function stop() {
    if (cleanup) return cleanup;
    stopped = true;
    if (timer) clearInterval(timer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    poller.setPollingOwner(false);
    poller.stop();
    release(sessionId);
    rpc.stop();
    cleanup = (async () => {
      if (lifecycleStarted) await finishSession(lifecycleId).catch(report);
      if (route) routes.remove(route.id, { pid: process.pid, processStart: route.processStart });
      const state = readCodexState(path);
      if (state?.pid === process.pid) save(path, { ...state, pid: undefined, start: undefined });
    })();
    return cleanup;
  }
  const onSignal = () => { void stop().catch(report); };

  try {
    withStateLock(path, () => {
      const current = readCodexState(path);
      if (current?.pid && sessionProcessAlive({ pid: current.pid, processStart: current.start })) throw new Error("Codex bridge is already running here");
      if (old && !old.routeId && (old.outbox?.length || scopedInbox(fileInbox(), botKey).claimed(String(bot.chatId)).some((message) => message.wake_claim?.startsWith("codex:")))) {
        throw new Error("legacy Codex deliveries have no isolated route; inspect their saved outbox/inbox before resuming, no delivery was replayed");
      }
      save(path, { ...old, threadId: old?.threadId ?? "", project, bot: botKey, chatId: bot.chatId, pid: process.pid, start });
    });
    await rpc.initialize();
    const result = await rpc.request(old?.threadId ? "thread/resume" : "thread/start", old?.threadId ? { threadId: old.threadId, developerInstructions: bridgeInstructions } : { cwd: project, serviceName: "telex", developerInstructions: bridgeInstructions });
    threadId = result.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread id");
    if (old?.threadId && threadId !== old.threadId) throw new Error("Codex resumed a different thread");
    const routeId = managedRouteId(project, threadId);
    if (old?.routeId && old.routeId !== routeId) throw new Error("Codex saved route differs from its thread/worktree binding");
    const previous = routes.get(routeId);
    if (previous?.pid && previous.pid !== process.pid) throw new Error("Codex thread is already connected in another process");
    route = { id: routeId, chatId: bot.chatId, botName, provider: "codex", ...sessionIdentity(project), allowFrom: bot.allowFrom, pid: process.pid, processStart: start };
    session = sessionFor(bot.token, route.id);
    session.setAnswerStore(fileAnswers(bot.token));
    session.setPollingOwner(false);
    session.setRoute(routes, route);
    store = scopedInbox(fileInbox(), `${botKey}:${route.id}`);
    session.setInboxStore(store);
    session.setInboxTtl(bot.chatId, config.queueExpirySeconds * 1000);
    save(path, { threadId, project, bot: botKey, chatId: bot.chatId, routeId, route,
      pid: process.pid, start, outbox: old?.outbox });
    lifecycleStarted = true;
    await announceSession({ id: lifecycleId, botName, bot, provider: "codex", project, routeId: route.id }).catch(report);
    for (const entry of old?.outbox ?? []) for (const message of entry.messages) {
      const claimed = store.claimed(String(bot.chatId)).find((item) => item.message_id === message.message_id);
      if (claimed?.wake_claim) {
        const acked = session.ackWake(bot.chatId, claimed.wake_claim);
        if (acked) await deliveredReceipt(session, bot.chatId, acked);
      }
    }
    touch({ session_id: sessionId, bot: botKey, project, repo: repoOf(project), agent: "codex-bridge", pid: process.pid, interval_seconds: 10 });
    claimPolling();
    console.log(`✓ Codex bridge listening in ${project}\n  Thread: ${threadId}\n  Bot: ${botName}\n  Ctrl+C stops the bridge.`);
    timer = setInterval(() => {
      if (readCodexState(path)?.disabled) { void stop().catch(report); return; }
      touch({ session_id: sessionId, bot: botKey, project, repo: repoOf(project), agent: "codex-bridge", pid: process.pid, interval_seconds: 10 });
      claimPolling();
      markExpired(session, bot.chatId, session.sweepInbox(Date.now(), bot.chatId));
      wake();
    }, 1000);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    wake();
  } catch (err) { await stop(); throw err; }
}
