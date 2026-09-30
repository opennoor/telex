/** Foreground Telegram bridge for a Telex-owned Codex app-server thread. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, pickBot } from "./config.ts";
import { fileInbox, scopedInbox } from "./inbox.ts";
import { statePath, registeredSessions, isLive, release, repoOf, touch } from "./registry.ts";
import { sessionFor, type Incoming } from "./telegram.ts";
import { deliveredReceipt, markExpired, receipt, refuse } from "./ask.ts";
import { processStart } from "./wake.ts";

type RpcMessage = { id?: number; method?: string; params?: any; result?: any; error?: { code?: number; message: string } };
type Outgoing = { turnId: string; messages: Incoming[]; text?: string };
type Saved = { threadId: string; project: string; bot: string; pid?: number; start?: string; disabled?: boolean; outbox?: Outgoing[] };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export class CodexRejection extends Error {}

export const codexStatePath = (project = process.cwd(), bot = "") =>
  join(dirname(statePath()), `codex-${createHash("sha256").update(`${repoOf(project)}:${bot}`).digest("hex").slice(0, 16)}.json`);

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

  constructor(command = "codex", args = ["app-server", "-c", 'plugins."telex@telex".enabled=false']) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TELEX_CODEX_BRIDGE: "1" },
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

export function codexStatus(name?: string) {
  const { bot } = pickBot(loadConfig(), name);
  const path = codexStatePath(process.cwd(), createHash("sha256").update(bot.token).digest("hex"));
  const state = readCodexState(path);
  let running = false;
  try { running = !!state?.pid && processStart(state.pid) === state.start; } catch { /* stopped */ }
  return { path, state, running };
}

export function disableCodex(name?: string) {
  const { path, state } = codexStatus(name);
  if (!state) return false;
  save(path, { ...state, disabled: true });
  return true;
}

export function pendingCodex(name?: string) {
  const { bot } = pickBot(loadConfig(), name);
  const key = createHash("sha256").update(bot.token).digest("hex");
  const claims = scopedInbox(fileInbox(), key).claimed(String(bot.chatId)).filter((m) => m.wake_claim?.startsWith("codex:"));
  return { claims, replies: codexStatus(name).state?.outbox ?? [] };
}

export async function recoverCodex(id: number, retry: boolean, name?: string) {
  const { bot } = pickBot(loadConfig(), name);
  if (codexStatus(name).running) throw new Error("disable the Codex bridge and inspect its thread before recovery");
  const key = createHash("sha256").update(bot.token).digest("hex");
  const session = sessionFor(bot.token);
  const store = scopedInbox(fileInbox(), key);
  const { path, state } = codexStatus(name);
  const reply = state?.outbox?.find((entry) => entry.messages.some((m) => m.message_id === id));
  if (reply) {
    if (retry && reply.text) await session.api("sendMessage", { chat_id: bot.chatId, text: reply.text.slice(0, 4000) });
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
  const { bot } = pickBot(config, name);
  if (!bot.allowFrom?.length) throw new Error("Codex bridge requires a nonempty --allow sender list");
  const botKey = createHash("sha256").update(bot.token).digest("hex");
  const path = codexStatePath(process.cwd(), botKey);
  const old = readCodexState(path);
  const project = process.cwd();
  if (old && (old.project !== project || old.bot !== botKey)) throw new Error(`Codex bridge binding differs: ${path}`);
  if (codexStatus(name).running) throw new Error("Codex bridge is already running here");
  const other = registeredSessions().find((s) => s.bot === botKey && isLive(s, Date.now()));
  if (other) throw new Error(`bot already used by ${other.agent} in ${other.project}; use a separate bot for Codex bridge`);
  const rpc = new CodexRpc();
  const sessionId = `codex-bridge:${process.pid}:${botKey}`;
  let stopped = false;
  let threadId = "";
  let currentTurnId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let sending = false;
  const session = sessionFor(bot.token);
  const store = scopedInbox(fileInbox(), botKey);
  session.setInboxStore(store);
  session.setInboxTtl(bot.chatId, config.queueExpirySeconds * 1000);
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
      const input = [{ type: "text", text: `Telegram message (${id}):\n${message.text}\n\nReply normally; Telex will forward your final answer to Telegram.` }];
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
      await session.api("sendMessage", { chat_id: bot.chatId, text: text.slice(0, 4000) });
      setOutbox(outbox().filter((item) => item.turnId !== turnId));
      replies.delete(turnId);
      wake();
    } finally { forwarding.delete(turnId); }
  }

  rpc.onEvent = (event) => {
    const { method, params } = event;
    if (method === "turn/started" && params?.threadId === threadId) currentTurnId = params.turn?.id;
    if (method === "item/completed" && params?.item?.type === "agentMessage" && params.item.phase !== "commentary") {
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
  rpc.onClose = (error) => { if (!stopped) { process.stderr.write(`telex: ${error.message}\n`); stop(); } };

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    session.stop();
    release(sessionId);
    rpc.stop();
    const state = readCodexState(path);
    if (state?.pid === process.pid) save(path, { ...state, pid: undefined, start: undefined });
  }

  try {
    await rpc.initialize();
    const result = await rpc.request(old?.threadId ? "thread/resume" : "thread/start", old?.threadId ? { threadId: old.threadId } : { cwd: project, serviceName: "telex" });
    threadId = result.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread id");
    if (old?.threadId && threadId !== old.threadId) throw new Error("Codex resumed a different thread");
    save(path, { threadId, project, bot: botKey, pid: process.pid, start: processStart(process.pid), outbox: old?.outbox });
    for (const entry of old?.outbox ?? []) for (const message of entry.messages) {
      const claimed = store.claimed(String(bot.chatId)).find((item) => item.message_id === message.message_id);
      if (claimed?.wake_claim) {
        const acked = session.ackWake(bot.chatId, claimed.wake_claim);
        if (acked) await deliveredReceipt(session, bot.chatId, acked);
      }
    }
    touch({ session_id: sessionId, bot: botKey, project, repo: repoOf(project), agent: "codex-bridge", pid: process.pid, interval_seconds: 10 });
    session.watch(bot.chatId, {
      allowFrom: bot.allowFrom,
      accept: () => !stopped,
      onRefused: (message) => void refuse(session, bot.chatId, message),
      onQueued: (message) => void receipt(session, bot.chatId, message).then(wake),
      onExpired: (messages) => markExpired(session, bot.chatId, messages),
    });
    console.log(`✓ Codex bridge listening in ${project}\n  Thread: ${threadId}\n  Bot: ${name ?? config.defaultBot}\n  Ctrl+C stops the bridge.`);
    timer = setInterval(() => {
      if (readCodexState(path)?.disabled) { stop(); return; }
      touch({ session_id: sessionId, bot: botKey, project, repo: repoOf(project), agent: "codex-bridge", pid: process.pid, interval_seconds: 10 });
      wake();
    }, 1000);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    wake();
  } catch (err) { stop(); throw err; }
}
