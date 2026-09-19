#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, pickBot, type Bot } from "./config.ts";
import { sessionFor, type BotSession } from "./telegram.ts";
import { ask, receipt, markExpired, refuse, heartbeat, deliver } from "./ask.ts";
import { touch, release, repoOf, ownerOf, type Session } from "./registry.ts";
import { fileInbox } from "./inbox.ts";
import { randomUUID } from "node:crypto";

const config = loadConfig();
const botNames = Object.keys(config.bots);
// A project pins its bot with TELEX_BOT in the MCP registration; the agent can still override per call.
const defaultBot = process.env.TELEX_BOT || config.defaultBot!;

/** Set once the agent has identified itself; until then telex has no interval and no owner. */
let checkedIn = false;

/**
 * Every telex on this machine queues into the same place. One process polls and a different one
 * may be the one that heartbeats, so a queue private to a process leaves the user's message held
 * by an agent that is not the one checking in.
 */
const shared = fileInbox();

function bind(bot: Bot): BotSession {
  const session = sessionFor(bot.token);
  session.setInboxStore(shared);
  return session;
}

/** Listen to a bot's chat for messages nobody asked for, and acknowledge each one to the user. */
function watch(bot: Bot): BotSession {
  const session = bind(bot);
  session.watch(bot.chatId, {
    allowFrom: bot.allowFrom,
    accept: () => checkedIn,
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
function claim(botName: string, bot: Bot, sessionId: string): { session: BotSession; owns: boolean } {
  // Nobody registered yet means nobody to defer to: the first process up starts listening.
  // Two starting in the same instant both listen until their first check-in settles it, which
  // is one poll cycle and self-correcting; registering needs an identity a caller supplies.
  const owns = (ownerOf(botName) ?? sessionId) === sessionId;
  if (owns) return { session: watch(bot), owns };
  const session = bind(bot);
  session.stop();
  return { session, owns };
}

const warned = new Set<string>();

/**
 * Every call says who is calling. That fixes the expiry clock from the very first interaction and,
 * through the shared registry, lets separate telex processes notice they share a bot.
 */
function checkIn(botName: string, bot: Bot, caller: Caller): { session: BotSession; sessionId: string; owns: boolean } {
  const sessionId = caller.session_id ?? processSession;
  // Register before claiming: ownership is decided from the registry, so this call has to be in it.
  const others = touch({
    session_id: sessionId,
    bot: botName,
    project: caller.project_path,
    repo: repoOf(caller.project_path),
    agent: caller.agent,
    pid: process.pid,
    interval_seconds: caller.interval_seconds,
  });
  const { session, owns } = claim(botName, bot, sessionId);
  session.setInboxTtl(bot.chatId, caller.interval_seconds * MISSED_BEATS * 1000);
  checkedIn = true;
  for (const other of others) {
    if (warned.has(other.session_id)) continue;
    warned.add(other.session_id);
    void conflictWarning(session, bot, caller, other);
  }
  return { session, sessionId, owns };
}

/** Telegram hands each update to one poller only, so a shared bot silently loses half the traffic. */
function conflictWarning(session: BotSession, bot: Bot, mine: Caller, other: Session) {
  return session.api("sendMessage", {
    chat_id: bot.chatId,
    parse_mode: "HTML",
    text: [
      "⚠️ <b>Two agents are using this bot at once</b>",
      "",
      `<code>${mine.agent}</code> — <code>${mine.project_path}</code>`,
      `<code>${other.agent}</code> — <code>${other.project}</code>`,
      "",
      "Telegram gives each message to only one of them, so answers will go missing.",
      "Give each project its own bot: <code>telex add &lt;name&gt;</code>.",
    ].join("\n"),
  }).catch(() => {});
}

const server = new McpServer({ name: "telex", version: "0.1.0" });
/** Heartbeats a message may sit through before telex gives up on the agent's behalf. */
const MISSED_BEATS = 3;

type Caller = { project_path: string; agent: string; interval_seconds: number; session_id?: string };

/**
 * Identifies this run of the server. An agent that never echoes its session id still gets one
 * stable identity; one that does keeps it across a restart, or hands it to whoever calls next.
 */
const processSession = randomUUID();

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
    const { name: targetName, bot: target } = pickBot(config, bot);
    const { session, sessionId } = checkIn(targetName, target, caller);
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
      "projects end up sharing one bot, which silently costs them half their messages.",
      `Bots: ${botNames.join(", ")} (default for this project: ${defaultBot}).`,
    ].join("\n"),
    inputSchema: {
      ...identity,
      bot: z.enum(botNames as [string, ...string[]]).optional()
        .describe(`Which configured bot to listen on. Defaults to "${defaultBot}".`),
    },
  },
  async ({ bot, ...caller }) => {
    const { name: targetName, bot: target } = pickBot(config, bot);
    const { session, sessionId } = checkIn(targetName, target, caller);
    return json({ messages: heartbeat(session, target.chatId), interval_seconds: caller.interval_seconds, session_id: sessionId });
  },
);

// Start listening before any agent checks in, so early messages get refused rather than ignored —
// unless another process in this project already holds the bot, in which case it is doing that.
const startup = pickBot(config);
claim(startup.name, startup.bot, processSession);

const transport = new StdioServerTransport();
// Polling now outlives any single request, so the process has to be told when the agent is gone.
transport.onclose = () => {
  release(processSession);
  process.exit(0);
};
process.on("exit", () => release(processSession));
await server.connect(transport);
