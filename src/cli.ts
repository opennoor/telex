#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from "node:util";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { readConfig, writeConfig, loadConfig, configPath, projectConfigPath, writeProjectConfig, maskToken, pickBot, type Bot } from "./config.ts";
import { addBotInteractive, installConfig } from "./setup.ts";
import { agents, snippet, type Entry } from "./agents.ts";
import { wakeConfigPath, processStart, processCommand, processDescendsFrom, withWakeInputLock } from "./wake.ts";
import { fileInbox, scopedInbox } from "./inbox.ts";
import { apiFor, TelegramError } from "./telegram.ts";
import { isLive, registeredSessions } from "./registry.ts";

const USAGE = `telex — send messages from local AI agents to Telegram

  telex serve                         run the MCP server (stdio); what agents launch
  telex add [name]                    add a bot, guided; or pass --token/--chat-id
  telex list                          show configured bots
  telex set <name> [options]          change a bot
  telex remove <name>                 delete a bot
  telex config [name]                 install the MCP registration into this project
  telex project <name>                pin this repository to a configured bot
  telex install [codex|claude]        install the bundled plugin for every project
  telex wake bind <pane> --socket <path>  enroll an existing detached Codex pane
  telex wake disable                 stop automatic terminal input
  telex wake pending                 list unconfirmed terminal submissions
  telex wake recover <id> --retry|--delivered  resolve one after checking the pane

Options for config:
  --agent <id>          skip the prompts: claude, codex
  --scope <local|project>  for agents with both: gitignored file or committed file
  --print               only show the commands and file syntax; write nothing
  -y, --yes             don't ask about the current directory

Options for add/set:
  --token <token>       bot token from @BotFather
  --chat-id <id>        chat the bot writes to (negative ids: --chat-id=-1001234567890)
  --allow <id,id>       Telegram user ids allowed to answer ("any" to clear)
  --default             make this the default bot

Config lives at ${configPath()} (override with TELEX_CONFIG).`;

// Resolves to src/index.ts in a checkout and dist/index.js once built.
const serverEntry = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "index.ts" : "index.js", import.meta.url));
const marketplaceRoot = fileURLToPath(new URL("../plugins/", import.meta.url));

/** Group chat ids are negative, and parseArgs reads a leading dash as another flag. */
const { values: flags, positionals } = parseArgsFriendly({
  allowPositionals: true,
  options: {
    token: { type: "string" },
    "chat-id": { type: "string" },
    allow: { type: "string" },
    default: { type: "boolean" },
    json: { type: "boolean" },
    agent: { type: "string" },
    scope: { type: "string" },
    print: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    help: { type: "boolean", short: "h" },
    socket: { type: "string" },
    retry: { type: "boolean" },
    delivered: { type: "boolean" },
  },
});

const [command, arg] = positionals;

function parseArgsFriendly<T extends ParseArgsConfig>(options: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(options);
  } catch (err) {
    const message = (err as Error).message;
    const negative = message.match(/Option '(--[a-z-]+)' argument is ambiguous/i);
    if (negative) {
      console.error(`✗ ${negative[1]} looks like it got a negative value. Write it as ${negative[1]}=-1001234567890.`);
      process.exit(1);
    }
    console.error(`✗ ${message.split("\n")[0]}`);
    process.exit(1);
  }
}

async function run(command: string, name?: string) {
  switch (command) {
    case "serve":
      await import("./index.ts");
      return;

    case "add": {
      const config = readConfig();
      if (name && config.bots[name]) throw new Error(`bot "${name}" already exists — use "telex set ${name}"`);
      // A token on the command line means the caller already knows everything; don't make them talk to a wizard.
      if (!flags.token) {
        const added = await addBotInteractive(name);
        if (flags.default) setDefault(added);
        return;
      }
      if (!flags["chat-id"]) throw new Error("--token also needs --chat-id");
      if (!name) throw new Error("give the bot a name: telex add <name> --token ... --chat-id ...");
      config.bots[name] = { token: flags.token, chatId: numeric(flags["chat-id"]), allowFrom: parseAllow(flags.allow) };
      config.defaultBot = flags.default || !config.defaultBot ? name : config.defaultBot;
      writeConfig(config);
      console.log(`✓ Added "${name}"${config.defaultBot === name ? " (default)" : ""}`);
      return;
    }

    case "set": {
      const config = readConfig();
      const bot = required(config.bots, name);
      if (flags.token) bot.token = flags.token;
      if (flags["chat-id"]) bot.chatId = numeric(flags["chat-id"]);
      if (flags.allow !== undefined) bot.allowFrom = parseAllow(flags.allow);
      if (flags.default) config.defaultBot = name;
      writeConfig(config);
      console.log(`✓ Updated "${name}"`);
      return;
    }

    case "remove": {
      const config = readConfig();
      required(config.bots, name);
      delete config.bots[name!];
      // Never leave defaultBot pointing at a bot that no longer exists.
      if (config.defaultBot === name) config.defaultBot = Object.keys(config.bots)[0];
      writeConfig(config);
      console.log(`✓ Removed "${name}"`);
      return;
    }

    case "list": {
      const config = readConfig();
      const names = Object.keys(config.bots);
      if (!names.length) return console.log(`No bots configured. Run "telex add".`);
      if (flags.json) return console.log(JSON.stringify(redact(config), null, 2));
      for (const n of names) {
        const bot = config.bots[n];
        const allow = bot.allowFrom?.length ? bot.allowFrom.join(", ") : "anyone in chat";
        console.log(`${n === config.defaultBot ? "*" : " "} ${n.padEnd(16)} chat ${String(bot.chatId).padEnd(16)} ${maskToken(bot.token)}  allow: ${allow}`);
      }
      console.log(`\n* = default. Config: ${configPath()}`);
      return;
    }

    case "config": {
      const config = readConfig();
      if (name) required(config.bots, name);
      const entry = { command: "telex", args: ["serve"], ...(name ? { env: { TELEX_BOT: name } } : {}) };
      if (flags.json) return console.log(JSON.stringify({ mcpServers: { telex: entry } }, null, 2));
      if (flags.print) return printConfigs(entry, name);
      await installConfig(name, { agent: flags.agent, scope: flags.scope, yes: flags.yes });
      return;
    }

    case "project": {
      const config = readConfig();
      required(config.bots, name);
      writeProjectConfig(name!);
      console.log(`✓ Pinned this project to "${name}" (${projectConfigPath()})`);
      return;
    }

    case "install": {
      if (positionals.length > 2) throw new Error("usage: telex install [codex|claude]");
      await installPlugin(name);
      return;
    }

    case "wake":
      await wakeCommand(name);
      return;

    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

async function wakeCommand(action?: string) {
  const path = wakeConfigPath();
  if (action === "bind") {
    const { bot } = pickBot(loadConfig());
    if (!bot.allowFrom?.length) throw new Error("wake requires a nonempty allowFrom list for this bot");
    const pane = positionals[2];
    if (!flags.socket?.startsWith("/") || !/^%\d+$/.test(pane ?? "")) {
      throw new Error("usage: telex wake bind <pane-id> --socket /absolute/tmux/socket");
    }
    if (existsSync(path)) throw new Error(`wake is already configured in ${path}; disable it first`);
    const fields = execFileSync("tmux", ["-S", flags.socket, "display-message", "-p", "-t", pane!,
      "#{pane_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}"], { encoding: "utf8" }).trim().split("\t");
    const [actualPane, session, rawPid, command, dead] = fields;
    if (actualPane !== pane || command !== "codex" || dead !== "0") throw new Error("wake needs a live, direct Codex pane");
    if (execFileSync("tmux", ["-S", flags.socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" })
      .trim().split("\n").filter((id) => id === pane).length !== 1) throw new Error("wake pane must not be linked into another tmux session");
    if (execFileSync("tmux", ["-S", flags.socket, "list-clients", "-t", session, "-F", "#{client_name}"], { encoding: "utf8" }).trim()) {
      throw new Error("detach the target tmux session before enrolling it for remote input");
    }
    const pid = Number(rawPid);
    if (processCommand(pid) !== "codex") throw new Error(
      "wake needs Codex itself as the pane process; start it with `exec codex --no-daemon resume <session-id>`"
    );
    const botKey = createHash("sha256").update(bot.token).digest("hex");
    const hostedHere = registeredSessions().some((entry) => {
      try {
        return entry.agent === "codex" && entry.bot === botKey && isLive(entry, Date.now()) &&
          processDescendsFrom(entry.pid, pid);
      } catch { return false; }
    });
    if (!hostedHere) throw new Error(
      "wake needs a recently checked-in Telex MCP process under this Codex pane. " +
      "Default daemon-hosted Codex cannot bind. Install the current Telex release, then resume this saved " +
      "conversation with `exec codex --no-daemon resume <session-id>`, finish a turn, detach, and bind."
    );
    const config = { socket: flags.socket, session, pane, pid, start: processStart(pid) };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(`✓ Bound ${pane} in detached tmux session ${session}. Telex will use its last idle Stop hook if still fresh.`);
    return;
  }
  if (action === "disable") {
    withWakeInputLock(() => { if (existsSync(path)) unlinkSync(path); });
    console.log("✓ Terminal wake disabled. Pending claims remain available with telex wake pending.");
    return;
  }
  const { bot } = pickBot(loadConfig());
  const store = scopedInbox(fileInbox(), createHash("sha256").update(bot.token).digest("hex"));
  if (action === "pending") {
    for (const message of store.claimed(String(bot.chatId))) console.log(`${message.message_id}\t${message.text}`);
    return;
  }
  if (action === "recover") {
    if (existsSync(path)) throw new Error("run telex wake disable and check the pane before recovery");
    const id = Number(positionals[2]);
    if (!Number.isSafeInteger(id) || id <= 0 || Boolean(flags.retry) === Boolean(flags.delivered)) {
      throw new Error("usage: telex wake recover <message-id> --retry|--delivered");
    }
    const message = store.claimed(String(bot.chatId)).find((entry) => entry.message_id === id);
    if (!message) throw new Error(`no pending wake claim for message ${id}`);
    if (message.receipt_id) {
      try {
        await apiFor(bot.token)("editMessageText", {
          chat_id: bot.chatId, message_id: message.receipt_id,
          text: flags.retry ? "🕦 <i>Held for the agent's next check-in.</i>" : "📬 <i>Submitted to Codex.</i>", parse_mode: "HTML",
        });
      } catch (err) {
        if (!(err instanceof TelegramError) || !/not modified/i.test(err.description)) throw err;
      }
    }
    store.resolve(String(bot.chatId), id, Boolean(flags.retry));
    console.log(`✓ Message ${id} ${flags.retry ? "released for retry" : "marked submitted"}.`);
    return;
  }
  throw new Error("usage: telex wake bind|disable|pending|recover");
}

async function installPlugin(value?: string) {
  let provider = value?.toLowerCase();
  if (!provider) {
    if (!process.stdin.isTTY) throw new Error("choose a host: telex install codex or telex install claude");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      provider = (await prompt.question("Install telex for (1) Codex or (2) Claude? ")).trim().toLowerCase();
    } finally {
      prompt.close();
    }
  }
  if (provider === "1") provider = "codex";
  if (provider === "2") provider = "claude";
  if (provider !== "codex" && provider !== "claude") throw new Error('choose "codex" or "claude"');

  const manifest = join(marketplaceRoot, provider === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json");
  if (!existsSync(manifest)) throw new Error(`bundled ${provider} marketplace is missing: ${manifest}`);
  const listed = JSON.parse(host(provider, ["plugin", "marketplace", "list", "--json"]));
  const marketplaces = provider === "codex" ? listed.marketplaces : listed;
  const existing = marketplaces.find((entry: any) => entry.name === "telex");
  if (existing) {
    const source = provider === "codex" ? existing.marketplaceSource?.source ?? existing.root : existing.path;
    if (!source || canonical(source) !== canonical(marketplaceRoot)) {
      throw new Error(`a telex marketplace already points elsewhere (${source ?? "unknown path"}); remove it with ${provider} plugin marketplace remove telex before retrying`);
    }
  }
  if (!existing || provider === "claude") {
    host(provider, ["plugin", "marketplace", "add", marketplaceRoot, ...(provider === "claude" ? ["--scope", "user"] : [])]);
  }
  host(provider, provider === "codex"
    ? ["plugin", "add", "telex@telex"]
    : ["plugin", "install", "telex@telex", "--scope", "user"]);
  console.log(`✓ Installed telex for ${provider}. Start a new ${provider === "codex" ? "Codex" : "Claude"} session${provider === "claude" ? " (or run /reload-plugins)" : ""} to load it.`);
}

function host(command: string, args: string[]) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch (err) {
    const failure = err as Error & { code?: string; stderr?: string | Buffer };
    if (failure.code === "ENOENT") throw new Error(`${command} is not on PATH`);
    throw new Error(`${command} ${args.join(" ")} failed: ${String(failure.stderr ?? failure.message).trim()}`);
  }
}

function canonical(path: string) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** What --print shows: every supported agent, its installer command or its config file. */
function printConfigs(entry: Entry, name?: string) {
  const list = agents();
  console.log(`Agents that install it for you — run in the project root:\n`);
  for (const agent of list.filter((a) => a.cli)) console.log(`  ${agent.label.padEnd(15)}${agent.cli!(name).join(" ")}`);

  console.log(`\nAgents you configure by writing a file:\n`);
  for (const agent of list.filter((a) => a.file)) {
    console.log(`  ${agent.label.padEnd(15)}${agent.file}${agent.localFile ? ` (or ${agent.localFile}, gitignored)` : ""}`);
    for (const line of snippet(agent, entry).split("\n")) console.log(`  ${" ".repeat(15)}${line}`);
    console.log();
  }

  console.log(`Codex reads .codex/config.toml only for projects you have trusted.`);
  if (name) console.log(`Messages from this project default to "${name}"; the agent can still pass another bot.`);
  else console.log(`Pass a bot name to pin this project to one: telex config <name>`);
  console.log(`\nIf "telex" is not on PATH, use: "command": "node", "args": ["${serverEntry}"]`);
}

function required(bots: Record<string, Bot>, name?: string): Bot {
  if (!name) throw new Error("which bot? pass its name");
  const bot = bots[name];
  if (!bot) throw new Error(`unknown bot "${name}". Configured: ${Object.keys(bots).join(", ") || "none"}`);
  return bot;
}

function setDefault(name: string) {
  const config = readConfig();
  config.defaultBot = name;
  writeConfig(config);
}

const numeric = (v: string) => (/^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim());

function parseAllow(value?: string): number[] | undefined {
  if (!value || value === "any") return undefined;
  return value.split(",").map((v) => {
    const id = Number(v.trim());
    if (!Number.isInteger(id)) throw new Error(`--allow takes numeric Telegram user ids, got "${v.trim()}"`);
    return id;
  });
}

const redact = (config: ReturnType<typeof readConfig>) => ({
  ...config,
  bots: Object.fromEntries(Object.entries(config.bots).map(([n, b]) => [n, { ...b, token: maskToken(b.token) }])),
});

try {
  if (flags.help || !command) {
    console.log(USAGE);
  } else {
    await run(command, arg);
  }
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
}
