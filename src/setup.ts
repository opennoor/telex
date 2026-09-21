/** Interactive bot onboarding: validate a token, learn the chat id by watching for a message. */
import { createInterface } from "node:readline/promises";
import { apiFor, type Update } from "./telegram.ts";
import { readConfig, writeConfig, configPath, writeProjectConfig, type Bot } from "./config.ts";
import { agents, runCli, writeFileConfig, ensureGitignored, type Agent, type Entry, type Result } from "./agents.ts";

const say = (s = "") => console.log(s);

export async function addBotInteractive(preferredName?: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    say("1. Open https://t.me/BotFather, send /newbot and follow the prompts.");
    say("   BotFather replies with a token like 8123456789:AAH...\n");

    const token = (await rl.question("Paste the bot token: ")).trim();
    const api = apiFor(token);
    const me = await api("getMe", {}).catch(() => {
      throw new Error("Telegram rejected that token. Copy the whole line BotFather sent, including the digits before the colon.");
    });
    say(`\n✓ Token belongs to @${me.username}\n`);

    say(`2. Open https://t.me/${me.username} and send it any message (say "hi").`);
    say("   Waiting...");
    const { chatId, userId, chatType } = await waitForFirstMessage(api);
    say(`\n✓ Chat id ${chatId}${chatType === "private" ? "" : ` (${chatType})`}, your user id ${userId}\n`);

    const config = readConfig();
    const fallback = preferredName ?? (Object.keys(config.bots).length ? "" : "main");
    const name =
      preferredName ?? ((await rl.question(`Name for this bot${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback);
    if (!name) throw new Error("a name is required");

    const bot: Bot = { token, chatId, allowFrom: [userId] };
    config.bots[name] = bot;
    config.defaultBot ??= name;
    writeConfig(config);
    say(`✓ Wrote ${configPath()} (default bot: ${config.defaultBot})`);

    await api("sendMessage", {
      chat_id: chatId,
      text: `<b>telex</b>\n\nSetup complete — bot "${name}" is ready.`,
      parse_mode: "HTML",
    });
    say("✓ Sent a test message; check Telegram.\n");
    return name;
  } finally {
    rl.close();
  }
}

/** Long-poll until the user messages the bot, skipping whatever was already queued. */
async function waitForFirstMessage(api: ReturnType<typeof apiFor>) {
  const seen: Update[] = await api("getUpdates", { offset: -1, timeout: 0 });
  let offset = seen.length ? seen[seen.length - 1].update_id + 1 : 0;
  for (;;) {
    const updates: Update[] = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      const msg = u.message as (Update["message"] & { chat: { type: string } }) | undefined;
      if (msg) return { chatId: msg.chat.id, userId: msg.from?.id ?? msg.chat.id, chatType: msg.chat.type };
    }
  }
}

/**
 * Install the MCP registration into the current project: confirm the directory, pick an
 * agent, then let that agent's CLI do it — or write the config file ourselves when it has none.
 */
export async function installConfig(bot: string | undefined, flags: { agent?: string; scope?: string; yes?: boolean }) {
  const dir = process.cwd();
  const list = agents();
  const entry: Entry = { command: "telex", args: ["serve"], ...(bot ? { env: { TELEX_BOT: bot } } : {}) };

  if (flags.scope && flags.scope !== "local" && flags.scope !== "project") throw new Error(`--scope takes "local" or "project"`);
  const interactive = !flags.agent && process.stdin.isTTY;
  if (!flags.agent && !interactive) throw new Error(`not a terminal — pass --agent <${list.map((a) => a.id).join("|")}> (or --print to just see the config)`);

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    let agent: Agent;
    if (flags.agent) {
      agent = list.find((a) => a.id === flags.agent) ?? (() => { throw new Error(`unknown agent "${flags.agent}". Known: ${list.map((a) => a.id).join(", ")}`); })();
    } else {
      if (!flags.yes) {
        const answer = (await rl!.question(`Install the telex MCP config in ${dir}? [Y/n] `)).trim().toLowerCase();
        if (answer && !answer.startsWith("y")) return say("Nothing written. cd to the project you want and run it there.");
      }
      say();
      list.forEach((a, i) => say(`  ${String(i + 1).padStart(2)}. ${a.label}`));
      const pick = Number((await rl!.question(`\nWhich agent? [1-${list.length}] `)).trim());
      if (!Number.isInteger(pick) || pick < 1 || pick > list.length) throw new Error("pick one of the listed numbers");
      agent = list[pick - 1];
    }

    if (agent.cli) {
      const argv = agent.cli(bot);
      const result = runCli(argv, dir);
      if (result) {
        if (result.ok && bot) writeProjectConfig(bot);
        return report(result, agent);
      }
      if (!agent.file) throw new Error(`${agent.label}'s CLI ("${argv[0]}") is not on PATH, and it has no config file telex can write.`);
      say(`! ${argv[0]} is not on PATH — writing ${agent.file} instead.\n`);
    }

    let local = flags.scope === "local";
    if (agent.localFile && !flags.scope) {
      if (!interactive) throw new Error(`${agent.label} needs --scope local (gitignored) or --scope project (committed)`);
      say(`\n  1. Committed  ${agent.file} — shared with the team`);
      say(`  2. Local only ${agent.localFile} — gitignored, just you`);
      local = (await rl!.question(`\nWhich one? [1-2] `)).trim() === "2";
    }

    const result = writeFileConfig(agent, entry, dir, local);
    const ignored = local && agent.localFile ? ensureGitignored(dir, agent.localFile) : null;
    report(result, agent);
    if (result.ok && bot) writeProjectConfig(bot);
    if (ignored) say(`✓ Added ${agent.localFile} to ${ignored}`);
  } finally {
    rl?.close();
  }
}

function report(result: Result, agent: Agent) {
  say(`${result.ok ? "✓" : "✗"} ${agent.label}: ${result.how}`);
  if (result.output) for (const line of result.output.split("\n")) say(`  ${line}`);
  if (!result.ok) process.exitCode = 1;
}
