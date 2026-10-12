#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, pickBot, type Bot } from "./config.ts";
import { sessionFor, type BotSession } from "./telegram.ts";
import { ask, receipt, markExpired, heartbeat, deliver, deliveredReceipt } from "./ask.ts";
import { touch, release, ownerOf, statePath } from "./registry.ts";
import { fileInbox, scopedInbox, moveInbox } from "./inbox.ts";
import { fileAnswers } from "./answers.ts";
import { fileRoutes, type RouteRegistration } from "./routes.ts";
import { announceSession, finishSession, identifySession, configuredProject, sessionIdentity } from "./lifecycle.ts";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { hookOutput, hostSessionId, boundHostSessionId, controls, processAncestors } from "./host.ts";
import { Wake, wakeTargetFromConfig, processStart, type WakeTarget } from "./wake.ts";
import { createServer } from "node:net";
import { mkdirSync, chmodSync, unlinkSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const config = loadConfig();
const botNames = Object.keys(config.bots);
const defaultBot = pickBot(config).name;
const channelMode = process.argv.includes("--channel");
const codexBridge = process.env.TELEX_CODEX_BRIDGE === "1";
const processSession = randomUUID();
let activeSession = process.env.TELEX_SESSION_ID
  ? hostSessionId("mcp", process.env.TELEX_SESSION_ID, process.cwd()) : randomUUID();
const pollKey = (bot: Bot) => createHash("sha256").update(bot.token).digest("hex");
const registrationId = (bot: Bot) => `${processSession}:${pollKey(bot)}`;
const routeId = (bot: Bot, id = activeSession) => `${id}:${bot.chatId}`;
const clientKey = (bot: Bot, id = activeSession) => `${pollKey(bot)}:${routeId(bot, id)}`;
const canonicalSession = (bot: Bot, id: string) => {
  const resolved = fileRoutes(bot.token).resolve(routeId(bot, id));
  return resolved.endsWith(`:${bot.chatId}`) ? resolved.slice(0, -String(bot.chatId).length - 1) : id;
};
const shared = fileInbox();
const clients = new Map<string, { bot: Bot; session: BotSession; route: RouteRegistration; lifecycle?: Promise<void>; lifecycleId: string }>();
const monitoredBots = new Map<string, Bot>();
const pollers = new Map<string, BotSession>();
let wake: Wake | undefined;
let wakeTarget: WakeTarget | undefined;
let lastIdleStop: { hostId: string; at: number } | undefined;
const report = (error: unknown) => { process.stderr.write(`telex: ${(error as Error).message}\n`); };

type Caller = { project_path: string; agent: string; interval_seconds: number; session_id?: string };

function bind(bot: Bot, caller: Caller, botName: string): BotSession {
  const routes = fileRoutes(bot.token);
  let parentRoute: RouteRegistration | undefined;
  if (codexBridge) {
    if (!process.env.TELEX_CODEX_STATE) throw new Error("telex: managed Codex binding is unavailable");
    const saved = JSON.parse(readFileSync(process.env.TELEX_CODEX_STATE, "utf8"));
    if (saved.bot !== pollKey(bot) || String(saved.chatId) !== String(bot.chatId) ||
        resolve(saved.project) !== resolve(caller.project_path) || !saved.pid ||
        !processAncestors(process.pid).includes(saved.pid) || (saved.start && processStart(saved.pid) !== saved.start)) {
      throw new Error("telex: managed Codex binding does not match this parent/thread/worktree");
    }
    parentRoute = routes.get(saved.routeId);
    if (!parentRoute || parentRoute.pid !== saved.pid) throw new Error("telex: managed Codex route is not active");
  }
  const id = parentRoute?.id ?? routeId(bot, caller.session_id ?? activeSession);
  const previous = routes.get(id);
  if (!codexBridge && previous?.pid && previous.pid !== process.pid) throw new Error("telex: that session is already connected in another process");
  const key = `${pollKey(bot)}:${id}`;
  let entry = clients.get(key);
  let start: string | undefined;
  try { start = processStart(process.pid); } catch { /* PID-only on non-Linux hosts */ }
  const route = parentRoute ?? { id, chatId: bot.chatId, botName, provider: caller.agent, ...sessionIdentity(caller.project_path),
    allowFrom: bot.allowFrom, pid: process.pid, processStart: start };
  if (!entry) {
    const session = sessionFor(bot.token, id);
    session.setAnswerStore(fileAnswers(bot.token));
    session.setPollingOwner(false);
    session.setInboxStore(scopedInbox(shared, key));
    session.setInboxTtl(bot.chatId, config.queueExpirySeconds * 1000);
    entry = { bot, session, route, lifecycleId: `${key}:${processSession}` };
    clients.set(key, entry);
  }
  entry.route = route;
  entry.session.setRoute(routes, route);
  return entry.session;
}

function track(bot: Bot, caller: Caller, botName: string) {
  if (codexBridge) return;
  const entry = clients.get(clientKey(bot, caller.session_id))!;
  if (entry.lifecycle) { identifySession(entry.lifecycleId, caller.agent, caller.project_path, entry.route.id); return; }
  entry.lifecycle = announceSession({ id: entry.lifecycleId, botName, bot, provider: caller.agent,
    project: caller.project_path, routeId: entry.route.id }).catch(report);
}

/** Local ownership is a fallback when the persistent listener is unavailable. */
function claim(bot: Bot) {
  const key = pollKey(bot);
  let poller = pollers.get(key);
  if (!poller) {
    poller = sessionFor(bot.token);
    poller.setAnswerStore(fileAnswers(bot.token));
    const routes = fileRoutes(bot.token);
    poller.setRouteStore(routes, (route, message) => {
      const inbox = scopedInbox(shared, `${key}:${route.id}`);
      inbox.push(String(route.chatId), message, Date.now() + config.queueExpirySeconds * 1000);
      const client = sessionFor(bot.token, route.id);
      client.setRoute(routes, route);
      client.setInboxStore(inbox);
      void receipt(client, route.chatId, message).then(() => pushChannel()).catch(report);
    });
    pollers.set(key, poller);
  }
  poller.setPollingOwner(!codexBridge && ownerOf(key) === registrationId(bot));
  if (!codexBridge) poller.listen();
}

function monitor(bot: Bot) {
  if (codexBridge) return;
  const key = pollKey(bot);
  if (monitoredBots.has(key)) return;
  monitoredBots.set(key, bot);
  touch({ session_id: registrationId(bot), bot: key, project: process.cwd(),
    agent: "telex-mcp", pid: process.pid, interval_seconds: 60 });
  claim(bot);
  setInterval(() => { claim(bot); reconcileWake(bot); void pushChannel(); }, 250).unref();
}

function checkIn(bot: Bot, caller: Caller, botName: string) {
  activeSession = codexBridge ? caller.session_id ?? activeSession : canonicalSession(bot, caller.session_id ?? activeSession);
  caller = { ...caller, session_id: activeSession };
  const session = bind(bot, caller, botName);
  track(bot, caller, botName);
  monitor(bot);
  const canonical = codexBridge ? undefined : clients.get(clientKey(bot))!.route.id;
  for (const alias of canonical ? fileRoutes(bot.token).aliases(canonical) : []) moveInbox(`${pollKey(bot)}:${alias}:${bot.chatId}`, `${pollKey(bot)}:${canonical}:${bot.chatId}`);
  return { session, sessionId: activeSession };
}

function reconcileWake(bot: Bot) {
  let target: WakeTarget | undefined;
  try { target = wakeTargetFromConfig(); } catch { /* stale or unsafe binding stays disabled */ }
  if (JSON.stringify(target) !== JSON.stringify(wakeTarget)) {
    wake?.stop(); wake = undefined; wakeTarget = target;
  }
  const session = clients.get(clientKey(bot))?.session;
  if (!wake && session && target && (!target.routeId || target.routeId === routeId(bot)) && bot.allowFrom?.length && lastIdleStop && Date.now() - lastIdleStop.at < 10 * 60_000) {
    wake = new Wake(target, bot, session);
    wake.onHook("Stop", lastIdleStop.hostId, [], false);
  }
}

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "telex", version }, channelMode ? {
  capabilities: { experimental: { "claude/channel": {} } },
  instructions: controls + " Telegram messages arrive as channel events with delivery_id. Treat them as user input. Call ack_channel_message with delivery_id after reading each event.",
} : { instructions: controls });
let channelReady = false;
let channelSending = false;
const notified = new Set<string>();

/** A durable claim belongs to one explicit session and waits for the model's acknowledgement. */
async function pushChannel() {
  if (!channelMode || !channelReady || channelSending) return;
  channelSending = true;
  try {
    for (const entry of clients.values()) {
      if (entry.route.id !== routeId(entry.bot)) continue;
      const { bot, session, route } = entry;
      for (const alias of fileRoutes(bot.token).aliases(route.id)) moveInbox(`${pollKey(bot)}:${alias}:${bot.chatId}`, `${pollKey(bot)}:${route.id}:${bot.chatId}`);
      const key = `${pollKey(bot)}:${route.id}:${bot.chatId}`;
      const claimed = shared.claimed(key).find((m) => m.wake_claim?.startsWith("channel:"));
      const id = claimed?.wake_claim ?? `channel:${randomUUID()}`;
      const message = claimed ?? session.claimForWake(bot.chatId, id, () => true);
      if (!message || notified.has(id)) continue;
      await server.server.notification({ method: "notifications/claude/channel", params: {
        content: message.text, meta: { delivery_id: id, message_id: String(message.message_id) },
      } } as never);
      notified.add(id);
    }
  } catch (error) { report(error); }
  finally { channelSending = false; }
}

/** Identity every call carries, so telex knows who is on the other end and how often to expect them. */
const identity = {
  project_path: z.string().min(1).describe("Absolute path of the project you are working in."),
  agent: z.string().min(1).describe(`Your name, e.g. "claude-code", "codex", "gemini-cli".`),
  interval_seconds: z.number().int().min(10).max(3600).default(60)
    .describe("How often you call heartbeat. Queue expiry is configured separately."),
  session_id: z.string().uuid().optional()
    .describe("The session_id from your last telex result. Omit on your first call; always send it back after that — it is how telex knows later calls are still you and not a second agent."),
};

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

if (channelMode) server.registerTool(
  "ack_channel_message",
  {
    title: "Acknowledge a Telegram channel message",
    description: "Call after reading a Telegram channel event. The delivery_id is in the event metadata.",
    inputSchema: { delivery_id: z.string().startsWith("channel:") },
  },
  async ({ delivery_id }) => {
    const entry = [...clients.values()].find(({ bot, route }) => route.id === routeId(bot) &&
      shared.claimed(`${pollKey(bot)}:${route.id}:${bot.chatId}`).some((m) => m.wake_claim === delivery_id));
    if (!entry) return json({ status: "unknown" });
    const { bot, session } = entry;
    const message = session.ackWake(bot.chatId, delivery_id);
    if (!message) return json({ status: "unknown" });
    notified.delete(delivery_id);
    await deliveredReceipt(session, bot.chatId, message);
    void pushChannel();
    return json({ status: "delivered" });
  },
);

server.registerTool(
  "send_to_user",
  {
    title: "Message the user on Telegram",
    description: [
      "Send a message to the user via Telegram and optionally wait for their answer.",
      "Use it to ask for a decision, get missing information, or report that long-running work finished.",
      "",
      "Style the message — an unformatted wall of text is hard to read on a phone. 'message' takes",
      `Telegram HTML: <b>the headline outcome</b>, <code>versions, paths, identifiers</code>, <i>asides</i>,`,
      `<a href="url">links</a>, <pre>blocks</pre>, <blockquote>quotes</blockquote>, <s>struck</s>, <u>underline</u>.`,
      "telex also converts **bold**, `code`, ``` fences ``` and [links](url) if you write Markdown by habit.",
      "Escape literal &, < and > as &amp; &lt; &gt;. Use real newlines, not <br>; layout tags are stripped.",
      "",
      "Pass 'options' for a multiple-choice question (buttons), or 'expect_text' for a free-text answer.",
      "With neither, the message is a one-way notification and returns immediately.",
      "",
      `If the user does not answer within 'timeout_seconds' the result is {"status":"timeout"}, the buttons`,
      "are removed and the message is marked stale. That means the user is unavailable — decide for yourself",
      "whether to continue, retry or stop.",
      "",
      "If the user messaged the bot while you were not asking anything, the result also carries a 'pending'",
      "array of what they said, delivered the same way a heartbeat would. Read it before you carry on.",
      "",
      "'project_path', 'agent' and 'interval_seconds' identify you. Until a call carries them telex has",
      "a durable destination. Replies and buttons return to that exact session.",
      `Bots: ${botNames.join(", ")} (default for this project: ${defaultBot}).`,
    ].join("\n"),
    inputSchema: {
      ...identity,
      project: z.string().min(1).describe("Project or task name, shown as the message heading."),
      message: z.string().min(1)
        .describe("The copy to show the user, in Telegram HTML. Style it: <b> the outcome, <code> every version, path and identifier."),
      options: z.array(z.string().min(1)).min(1).max(10).optional()
        .describe("Single-choice answers, rendered as buttons. Mutually exclusive with expect_text."),
      expect_text: z.boolean().optional()
        .describe("Show a Reply button; the user's next message is returned as the answer."),
      timeout_seconds: z.number().int().min(5).max(86400).default(config.questionTimeoutSeconds)
        .describe("How long to wait for an answer before giving up."),
      bot: z.enum(botNames as [string, ...string[]]).optional()
        .describe(`Which configured bot to send through. Defaults to "${defaultBot}".`),
    },
  },
  async ({ project, message, options, expect_text, timeout_seconds, bot, ...caller }) => {
    const { bot: target, name } = pickBot(config, bot);
    const { session, sessionId } = checkIn(target, caller, name);
    const result = await ask(session, target.chatId, {
      project,
      message,
      options,
      expectText: expect_text,
      timeoutSeconds: timeout_seconds,
      allowFrom: target.allowFrom,
    });
    const pending = channelMode || codexBridge ? [] : deliver(session, target.chatId);
    return json({ ...result, ...(pending.length ? { pending } : {}), session_id: sessionId });
  },
);

server.registerTool(
  "heartbeat",
  {
    title: "Check in and collect anything the user said",
    description: [
      "Call this on a fixed interval for the whole time you are working, and pass that interval as",
      "'interval_seconds'. It returns immediately with whatever the user has messaged the bot since",
      "your last check-in — it never blocks and never waits for them.",
      "",
      "Two jobs in one call. It delivers unprompted messages, and it is your liveness signal: the",
      "user sees each of their messages marked as held, then delivered once a heartbeat collects it.",
      `Messages expire after ${config.queueExpirySeconds} seconds if unclaimed, which is how`,
      "the user learns you were not listening rather than being ignored in silence.",
      "",
      `The result is {"messages":[...],"interval_seconds":n,"session_id":"..."}. An empty array means`,
      "nothing was said — that is the normal case, keep working and check in again next interval.",
      "",
      "'project_path' and 'agent' identify you. telex records them so it can warn the user when two",
      "sessions share a bot; ambiguous unsolicited messages offer a session selector.",
      `Bots: ${botNames.join(", ")} (default for this project: ${defaultBot}).`,
    ].join("\n"),
    inputSchema: {
      ...identity,
      bot: z.enum(botNames as [string, ...string[]]).optional()
        .describe(`Which configured bot to listen on. Defaults to "${defaultBot}".`),
    },
  },
  async ({ bot, ...caller }) => {
    const { bot: target, name } = pickBot(config, bot);
    const { session, sessionId } = checkIn(target, caller, name);
    return json({ messages: channelMode || codexBridge ? [] : heartbeat(session, target.chatId), interval_seconds: caller.interval_seconds, session_id: sessionId });
  },
);

// Native plugin hooks call this tool at host lifecycle events. The MCP process remains the
// sole Telegram poller, and the same check-in/delivery path serves hosts without hook support.
server.registerTool(
  "host_hook",
  {
    title: "Telex host lifecycle hook",
    description: "Plugin hook entry point. Host-managed calls check in and deliver Telegram messages to the active turn.",
    inputSchema: {
      event: z.enum(["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "Stop"]),
      host_session_id: z.string().min(1),
      project_path: identity.project_path,
      agent: identity.agent,
      stop_hook_active: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional(),
      prompt: z.string().optional(),
    },
  },
  async ({ event, host_session_id, project_path, agent, stop_hook_active, prompt }) =>
    json(await handleHostHook({ event, host_session_id, project_path, agent, stop_hook_active, prompt })),
);

type HostHook = {
  event: "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "PostToolUse" | "Stop";
  host_session_id: string;
  project_path: string;
  agent: string;
  stop_hook_active?: boolean;
  prompt?: string;
};

async function handleHostHook({ event, host_session_id, project_path, agent, stop_hook_active, prompt }: HostHook) {
  const { bot, name } = pickBot(config);
  const id = boundHostSessionId(agent, host_session_id, project_path, !hookHostId ? activeSession : undefined);
  if (event === "SessionEnd") {
    for (const entry of clients.values()) if (entry.route.id === routeId(entry.bot, id)) {
      await entry.lifecycle;
      await finishSession(entry.lifecycleId).catch(report);
      fileRoutes(entry.bot.token).remove(entry.route.id, { pid: process.pid, processStart: entry.route.processStart });
      clients.delete(clientKey(entry.bot, id));
    }
    return {};
  }
  const provisional = !hookHostId && activeSession !== id ? clients.get(clientKey(bot)) : undefined;
  if (provisional) {
    const migrated = { ...provisional.route, id: routeId(bot, id), provider: agent, ...sessionIdentity(project_path) };
    fileRoutes(bot.token).rebind(provisional.route.id, migrated);
    moveInbox(`${pollKey(bot)}:${provisional.route.id}:${bot.chatId}`, `${pollKey(bot)}:${migrated.id}:${bot.chatId}`);
    bind(bot, { project_path, agent, interval_seconds: 60, session_id: id }, name);
    const destination = clients.get(clientKey(bot, id))!;
    destination.lifecycle = provisional.lifecycle;
    destination.lifecycleId = provisional.lifecycleId;
    clients.delete(clientKey(bot));
  }
  hookHostId = host_session_id;
  const { session } = checkIn(bot, { project_path, agent, interval_seconds: 60, session_id: id }, name);
  const messages = channelMode || codexBridge || event === "Stop" && stop_hook_active ? [] : heartbeat(session, bot.chatId);
  lastIdleStop = event === "Stop" && agent === "codex" && !stop_hook_active && messages.length === 0
    ? { hostId: host_session_id, at: Date.now() } : undefined;
  reconcileWake(bot);
  if (event !== "SessionStart") wake?.onHook(event, host_session_id, messages, stop_hook_active, prompt);
  return hookOutput(event, messages);
}

const startup = pickBot(config);
if (channelMode && !startup.bot.allowFrom?.length) throw new Error("telex: channel mode requires a nonempty allowFrom sender list");
let hookHostId: string | undefined;
const hookSocket = join(dirname(statePath()), `hook-${process.pid}-${randomUUID()}.sock`);
const hookServer = createServer((connection) => {
  connection.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") report(error);
  });
  connection.setTimeout(1500, () => connection.destroy());
  let input = "";
  connection.on("data", async (chunk: Buffer) => {
    input += chunk.toString("utf8");
    if (input.length > 65_536) return connection.destroy();
    const line = input.indexOf("\n");
    if (line < 0) return;
    connection.removeAllListeners("data");
    let response: object = { accepted: false };
    try {
      const value = JSON.parse(input.slice(0, line)) as HostHook & { probe?: boolean; ancestors?: number[] };
      const eligible = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "Stop"].includes(value.event) &&
        typeof value.host_session_id === "string" && value.host_session_id.length > 0 &&
        typeof value.project_path === "string" && resolve(value.project_path) === resolve(process.cwd()) &&
        (!hookHostId || hookHostId === value.host_session_id);
      if (eligible) {
        if (value.probe) response = { eligible: true, bound: hookHostId === value.host_session_id, ancestors: processAncestors(process.pid) };
        else response = { accepted: true, output: await handleHostHook(value) };
      }
    } catch (error) { report(error); }
    if (!connection.destroyed) connection.end(`${JSON.stringify(response)}\n`);
  });
});
mkdirSync(dirname(hookSocket), { recursive: true });
await new Promise<void>((resolve, reject) => {
  hookServer.once("error", reject);
  hookServer.listen(hookSocket, () => { hookServer.removeListener("error", reject); resolve(); });
});
chmodSync(hookSocket, 0o600);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  hookServer.close();
  try { unlinkSync(hookSocket); } catch { /* already gone */ }
  wake?.stop();
  for (const poller of pollers.values()) { poller.setPollingOwner(false); poller.stop(); }
  for (const entry of clients.values()) {
    if (codexBridge) continue;
    await entry.lifecycle;
    if (entry.lifecycle) await finishSession(entry.lifecycleId).catch(report);
    fileRoutes(entry.bot.token).remove(entry.route.id, { pid: process.pid, processStart: entry.route.processStart });
  }
  for (const bot of monitoredBots.values()) release(registrationId(bot));
  process.exit(0);
}
const transport = new StdioServerTransport();
transport.onclose = () => void close();
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.on("exit", () => {
  try { unlinkSync(hookSocket); } catch { /* already gone */ }
  for (const bot of monitoredBots.values()) release(registrationId(bot));
});
await server.connect(transport);
channelReady = true;
let pendingStart: HostHook | undefined;
try {
  const ancestors = processAncestors(process.pid);
  const pending = readdirSync(dirname(statePath())).filter((file) => /^hook-start-[a-f0-9]+\.json$/.test(file))
    .map((file) => JSON.parse(readFileSync(join(dirname(statePath()), file), "utf8")))
    .filter((event) => event.event === "SessionStart" && resolve(event.project_path) === resolve(process.cwd()) &&
      ancestors.includes(event.hostPid) && processStart(event.hostPid) === event.hostStart)
    .sort((a, b) => b.at - a.at);
  pendingStart = pending[0];
} catch { /* no exact host startup was spooled */ }
if (pendingStart) {
  hookHostId = pendingStart.host_session_id;
  activeSession = boundHostSessionId(pendingStart.agent, pendingStart.host_session_id, process.cwd());
}
const startupCaller = { project_path: process.cwd(), agent: pendingStart?.agent ?? (channelMode ? "claude-code" : process.env.TELEX_AGENT ?? "mcp"), interval_seconds: 60 };
if (!codexBridge) activeSession = canonicalSession(startup.bot, activeSession);
if (!codexBridge) bind(startup.bot, startupCaller, startup.name);
if (!codexBridge && (configuredProject(process.cwd()) || channelMode)) track(startup.bot, startupCaller, startup.name);
monitor(startup.bot);
void pushChannel();
