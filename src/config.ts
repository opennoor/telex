import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** allowFrom: Telegram user ids permitted to answer. Omit to trust anyone in the chat. */
export type Bot = { token: string; chatId: number | string; allowFrom?: number[] };
export type Config = {
  defaultBot?: string;
  bots: Record<string, Bot>;
  queueExpirySeconds?: number;
  questionTimeoutSeconds?: number;
};

export const DEFAULT_QUEUE_EXPIRY_SECONDS = 3600;
export const DEFAULT_QUESTION_TIMEOUT_SECONDS = 600;

export const configPath = () =>
  process.env.TELEX_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "telex", "config.json");

/** Repository-local routing, deliberately containing a bot name only (never a token). */
export const projectConfigPath = () =>
  process.env.TELEX_PROJECT_CONFIG ?? join(process.cwd(), ".telex.json");

export type ProjectConfig = { bot?: string };

export function readProjectConfig(): ProjectConfig {
  const primary = projectConfigPath();
  const path = existsSync(primary) ? primary : join(process.cwd(), ".telex", "config.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
    return typeof raw?.bot === "string" ? { bot: raw.bot } : {};
  } catch (err) {
    throw new Error(`telex: ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export function writeProjectConfig(bot: string) {
  const path = projectConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ bot }, null, 2)}\n`);
}

/** Config as it is on disk, or an empty one. For the CLI, which has to cope with "nothing yet". */
export function readConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return { bots: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Config;
    return {
      defaultBot: raw.defaultBot,
      bots: raw.bots ?? {},
      queueExpirySeconds: raw.queueExpirySeconds,
      questionTimeoutSeconds: raw.questionTimeoutSeconds,
    };
  } catch (err) {
    throw new Error(`telex: ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export function writeConfig(config: Config) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Validated config for the server, which cannot do anything useful without at least one bot. */
export function loadConfig(): Config & { queueExpirySeconds: number; questionTimeoutSeconds: number } {
  const config = readConfig();
  const names = Object.keys(config.bots);
  if (names.length === 0) throw new Error(`telex: no bots configured in ${configPath()} — run "telex add"`);
  for (const [name, bot] of Object.entries(config.bots)) {
    if (!bot?.token || bot.chatId === undefined) throw new Error(`telex: bot "${name}" needs both token and chatId`);
  }
  if (config.defaultBot && !config.bots[config.defaultBot]) {
    throw new Error(`telex: defaultBot "${config.defaultBot}" is not in bots`);
  }
  const queueExpirySeconds = config.queueExpirySeconds ?? DEFAULT_QUEUE_EXPIRY_SECONDS;
  const questionTimeoutSeconds = config.questionTimeoutSeconds ?? DEFAULT_QUESTION_TIMEOUT_SECONDS;
  for (const [key, value] of Object.entries({ queueExpirySeconds, questionTimeoutSeconds })) {
    if (!Number.isSafeInteger(value) || value < 5 || value > 86400) {
      throw new Error(`telex: ${key} must be an integer from 5 to 86400 seconds`);
    }
  }
  return { ...config, defaultBot: config.defaultBot ?? names[0], queueExpirySeconds, questionTimeoutSeconds };
}

/**
 * Which bot a call goes to: the agent's argument wins, then the bot pinned for this
 * project via TELEX_BOT, then the global default.
 */
export function pickBot(config: Config, name?: string): { name: string; bot: Bot } {
  const key = name || process.env.TELEX_BOT || readProjectConfig().bot || config.defaultBot!;
  const bot = config.bots[key];
  if (!bot) throw new Error(`telex: unknown bot "${key}". Configured: ${Object.keys(config.bots).join(", ")}`);
  return { name: key, bot };
}

export const maskToken = (token: string) => `${token.split(":")[0]}:${"*".repeat(6)}${token.slice(-4)}`;
