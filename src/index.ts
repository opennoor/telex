#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, pickBot, type Bot } from "./config.ts";
import { sessionFor, type BotSession } from "./telegram.ts";
import { ask, receipt, markExpired, refuse, heartbeat, deliver } from "./ask.ts";
import { touch, release, repoOf, ownerOf, type Session } from "./registry.ts";
import { fileInbox, scopedInbox } from "./inbox.ts";
import { fileAnswers } from "./answers.ts";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { hookOutput, hostSessionId } from "./host.ts";

const config = loadConfig();
const botNames = Object.keys(config.bots);
// A project pins its bot with TELEX_BOT in the MCP registration; the agent can still override per call.
const defaultBot = process.env.TELEX_BOT || config.defaultBot!;

/** Set once the agent has identified itself; until then telex has no interval and no owner. */
const checkedIn = new Set<string>();
/** Public MCP identity may be echoed across calls or a host restart. */
let activeSession: string = randomUUID();

/**
 * Every telex on this machine queues into the same place. One process polls and a different one
 * may be the one that heartbeats, so a queue private to a process leaves the user's message held
 * by an agent that is not the one checking in.
 */
const shared = fileInbox();

function bind(bot: Bot): BotSession {
  const session = sessionFor(bot.token);
  session.setInboxStore(scopedInbox(shared, pollKey(bot)));
  session.setAnswerStore(fileAnswers(bot.token));
  return session;
}

/** Listen to a bot's chat for messages nobody asked for, and acknowledge each one to the user. */
function watch(bot: Bot): BotSession {
  const session = bind(bot);
  session.watch(bot.chatId, {
    allowFrom: bot.allowFrom,
    accept: () => checkedIn.has(pollKey(bot)),
    onRefused: (message) => void refuse(session, bot.chatId, message),
    onQueued: (message) => void receipt(session, bot.chatId, message),
    onExpired: (messages) => markExpired(session, bot.chatId, messages),
  });
  return session;
}

/**
 * Poll only while this process holds the bot.
 *
 * Telegram serves an update to whoever asks and confirms it only when that asker returns with a
 * higher offset, so two pollers on one token duplicate receipts and swallow replies. Symphony runs
 * a lead and its workers inside one repository, all on one bot, each with its own telex — which is
 * how a single message came back acknowledged twice.
 */
const pollKey = (bot: Bot) => createHash("sha256").update(bot.token).digest("hex");
const registrationId = (bot: Bot) => `${processSession}:${pollKey(bot)}`;
const claimState = new Map<string, boolean>();
const monitoredBots = new Map<string, Bot>();

function claim(bot: Bot, sessionId: string): { session: BotSession; owns: boolean } {
  // ponytail: before either process checks in there can be two brief startup polls. A process
  // lease would close this gap; keep early-message refusal without a second always-on daemon.
  const key = pollKey(bot);
  const owns = (ownerOf(key) ?? sessionId) === sessionId;
  if (claimState.get(key) === owns) return { session: sessionFor(bot.token), owns };
  claimState.set(key, owns);
  if (owns) {
    const session = watch(bot);
    session.setPollingOwner(true);
    return { session, owns };
  }
  const session = bind(bot);
  session.setPollingOwner(false);
  session.stop();
  return { session, owns };
}

/** Reconcile ownership while a question waits, even if the host emits no further hooks. */
function monitor(bot: Bot) {
  const key = pollKey(bot);
  if (monitoredBots.has(key)) return;
  monitoredBots.set(key, bot);
  setInterval(() => claim(bot, registrationId(bot)), 1000).unref();
}

const warned = new Set<string>();

/**
 * Every call says who is calling. That fixes the expiry clock from the very first interaction and,
 * through the shared registry, lets separate telex processes notice they share a bot.
 */
function checkIn(bot: Bot, caller: Caller): { session: BotSession; sessionId: string; owns: boolean } {
  const sessionId = caller.session_id ?? activeSession;
  activeSession = sessionId;
  // Registry ownership belongs to this process even when two hosts echo the same public session id.
  const others = touch({
    session_id: registrationId(bot),
    bot: pollKey(bot),
    project: caller.project_path,
    repo: repoOf(caller.project_path),
    agent: caller.agent,
    pid: process.pid,
    interval_seconds: caller.interval_seconds,
  });
  const { session, owns } = claim(bot, registrationId(bot));
  monitor(bot);
  session.setInboxTtl(bot.chatId, caller.interval_seconds * MISSED_BEATS * 1000);
  checkedIn.add(pollKey(bot));
  for (const other of others) {
    if (warned.has(other.session_id)) continue;
    warned.add(other.session_id);
    void conflictWarning(session, bot, caller, other);
  }
  return { session, sessionId, owns };
}

/** Two unrelated projects cannot know which one an unsolicited chat message was meant for. */
function conflictWarning(session: BotSession, bot: Bot, mine: Caller, other: Session) {
  return session.api("sendMessage", {
    chat_id: bot.chatId,
    parse_mode: "HTML",
    text: [
      "⚠️ <b>Two projects are using this bot at once</b>",
      "",
      `<code>${mine.agent}</code> — <code>${mine.project_path}</code>`,
      `<code>${other.agent}</code> — <code>${other.project}</code>`,
      "",
      "Messages in this chat cannot be routed reliably between projects.",
      "Give each project its own bot: <code>telex add &lt;name&gt;</code>.",
    ].join("\n"),
  }).catch(() => {});
}

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "telex", version });
/** Heartbeats a message may sit through before telex gives up on the agent's behalf. */
const MISSED_BEATS = 3;

type Caller = { project_path: string; agent: string; interval_seconds: number; session_id?: string };

/** Poll ownership is per process, even if two processes receive the same host session id. */
const processSession = activeSession;

/** Identity every call carries, so telex knows who is on the other end and how often to expect them. */
const identity = {
  project_path: z.string().min(1).describe("Absolute path of the project you are working in."),
  agent: z.string().min(1).describe(`Your name, e.g. "claude-code", "codex", "gemini-cli".`),
  interval_seconds: z.number().int().min(10).max(3600).default(60)
    .describe(`How often you call heartbeat. Messages expire after ${3} missed intervals, so be honest.`),
  session_id: z.string().uuid().optional()
    .describe("The session_id from your last telex result. Omit on your first call; always send it back after that — it is how telex knows later calls are still you and not a second agent."),
};

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

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
      "no owner for this bot, and anything the user sends is refused rather than held.",
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
      timeout_seconds: z.number().int().min(5).max(86400).default(300)
        .describe("How long to wait for an answer before giving up."),
      bot: z.enum(botNames as [string, ...string[]]).optional()
        .describe(`Which configured bot to send through. Defaults to "${defaultBot}".`),
    },
  },
  async ({ project, message, options, expect_text, timeout_seconds, bot, ...caller }) => {
    const { bot: target } = pickBot(config, bot);
    const { session, sessionId } = checkIn(target, caller);
    const result = await ask(session, target.chatId, {
      project,
      message,
      options,
      expectText: expect_text,
      timeoutSeconds: timeout_seconds,
      allowFrom: target.allowFrom,
    });
    const pending = deliver(session, target.chatId);
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
      `Miss ${MISSED_BEATS} intervals in a row and anything waiting is marked expired and dropped, which is how`,
      "the user learns you were not listening rather than being ignored in silence.",
      "",
      `The result is {"messages":[...],"interval_seconds":n,"session_id":"..."}. An empty array means`,
      "nothing was said — that is the normal case, keep working and check in again next interval.",
      "",
      "'project_path' and 'agent' identify you. telex records them so it can warn the user when two",
      "projects share one bot and unsolicited messages become ambiguous.",
      `Bots: ${botNames.join(", ")} (default for this project: ${defaultBot}).`,
    ].join("\n"),
    inputSchema: {
      ...identity,
      bot: z.enum(botNames as [string, ...string[]]).optional()
        .describe(`Which configured bot to listen on. Defaults to "${defaultBot}".`),
    },
  },
  async ({ bot, ...caller }) => {
    const { bot: target } = pickBot(config, bot);
    const { session, sessionId } = checkIn(target, caller);
    return json({ messages: heartbeat(session, target.chatId), interval_seconds: caller.interval_seconds, session_id: sessionId });
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
      event: z.enum(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]),
      host_session_id: z.string().min(1),
      project_path: identity.project_path,
      agent: identity.agent,
      stop_hook_active: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional(),
    },
  },
  async ({ event, host_session_id, project_path, agent, stop_hook_active }) => {
    const { bot } = pickBot(config);
    const { session } = checkIn(bot, {
      project_path, agent, interval_seconds: 60, session_id: hostSessionId(agent, host_session_id, processSession),
    });
    // A second Stop continuation must not consume a new message that it cannot pass to the model.
    const messages = event === "Stop" && stop_hook_active ? [] : heartbeat(session, bot.chatId);
    return json(hookOutput(event, messages));
  },
);

// Start listening before any agent checks in, so early messages get refused rather than ignored —
// unless another process in this project already holds the bot, in which case it is doing that.
const startup = pickBot(config);
claim(startup.bot, registrationId(startup.bot));
monitor(startup.bot);

const transport = new StdioServerTransport();
// Polling now outlives any single request, so the process has to be told when the agent is gone.
transport.onclose = () => {
  for (const bot of monitoredBots.values()) release(registrationId(bot));
  process.exit(0);
};
process.on("exit", () => {
  for (const bot of monitoredBots.values()) release(registrationId(bot));
});
await server.connect(transport);
