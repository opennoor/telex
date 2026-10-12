/** Process lifetime announcements, independent of host turn/idle events. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readConfig, type Bot } from "./config.ts";
import { repoOf, statePath, withStateLock } from "./registry.ts";
import { processStart } from "./wake.ts";
import { apiFor, BotSession } from "./telegram.ts";
import { fileRoutes, fileRoutesByHash } from "./routes.ts";

export type SessionIdentity = { repo: string; branch: string; worktree: string };
export type LifecycleSession = SessionIdentity & {
  id: string; botName: string; botHash: string; chatId: number | string; provider: string; project: string; routeId?: string;
  pid: number; processStart?: string; startedAt: number;
  start?: "sending" | "sent" | "failed" | "suppressed";
  end?: "sending" | "sent" | "failed" | "suppressed";
  reason?: string;
};
export type LifecycleSend = (bot: Bot, record: LifecycleSession, text: string) => Promise<unknown>;
const root = () => join(dirname(statePath()), "lifecycle");
const pathFor = (id: string) => join(root(), `${createHash("sha256").update(id).digest("hex")}.json`);
const read = (id: string): LifecycleSession | undefined => {
  try { return JSON.parse(readFileSync(pathFor(id), "utf8")); } catch { return undefined; }
};
const write = (record: LifecycleSession) => {
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  const path = pathFor(record.id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, path);
};

export function configuredProject(project: string): boolean {
  const primary = process.env.TELEX_PROJECT_CONFIG ?? join(project, ".telex.json");
  const path = existsSync(primary) ? primary : join(project, ".telex", "config.json");
  try { return typeof JSON.parse(readFileSync(path, "utf8"))?.bot === "string"; }
  catch { return false; }
}

export function sessionIdentity(project: string): SessionIdentity {
  let branch = "unknown";
  try {
    branch = execFileSync("git", ["-C", project, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { /* a directory outside git still has a stable identity */ }
  return { repo: repoOf(project), branch, worktree: resolve(project) };
}

export function sessionProcessAlive(record: Pick<LifecycleSession, "pid" | "processStart">): boolean {
  try {
    process.kill(record.pid, 0);
    return !record.processStart || processStart(record.pid) === record.processStart;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const send: LifecycleSend = async (bot, record, text) => {
  const session = new BotSession(apiFor(bot.token));
  if (record.routeId) {
    const routes = fileRoutes(bot.token);
    const current = routes.get(record.routeId);
    const resumed = current?.pid !== undefined && (current.pid !== record.pid || current.processStart !== record.processStart);
    session.setRoute({ ...routes, register() {} }, { id: resumed ? `${record.routeId}:ended:${record.id}` : record.routeId,
      chatId: bot.chatId, botName: record.botName,
      provider: record.provider, repo: record.repo, branch: record.branch, worktree: record.worktree,
      allowFrom: bot.allowFrom, pid: record.pid, processStart: record.processStart,
      ...(record.reason ? { expiresAt: Date.now() } : {}) });
  }
  await session.api("sendMessage", { chat_id: bot.chatId, text }, AbortSignal.timeout(5000));
};
const message = (record: LifecycleSession, event: string) => [
  `Telex session ${event}`, `Bot: ${record.botName}`, `Agent: ${record.provider}`, `Session: ${record.routeId ?? record.id}`,
  `Repository: ${record.repo}`, `Branch: ${record.branch}`, `Worktree: ${record.worktree}`,
].join("\n");

async function notify(id: string, event: "start" | "end", bot: Bot, sender: LifecycleSend) {
  const record = withStateLock(pathFor(id), () => {
    const record = read(id);
    if (!record || record[event]) return undefined;
    // Telegram has no idempotency key: persist the attempt before sending to avoid replay on restart.
    record[event] = "sending";
    write(record);
    return record;
  });
  if (!record) return;
  try {
    await sender(bot, record, message(record, event === "start" ? "started" : record.reason ?? "ended"));
    withStateLock(pathFor(id), () => { const current = read(id)!; current[event] = "sent"; write(current); });
  } catch (error) {
    withStateLock(pathFor(id), () => { const current = read(id)!; current[event] = "failed"; write(current); });
    throw error;
  }
}

export async function announceSession(input: {
  id: string; botName: string; bot: Bot; provider: string; project: string; routeId?: string; pid?: number;
}, sender: LifecycleSend = send): Promise<void> {
  const configured = configuredProject(input.project);
  withStateLock(pathFor(input.id), () => {
    if (read(input.id)) return;
    const pid = input.pid ?? process.pid;
    let start: string | undefined;
    try { start = processStart(pid); } catch { /* other operating systems have PID-only liveness */ }
    write({ id: input.id, botName: input.botName, botHash: createHash("sha256").update(input.bot.token).digest("hex"), chatId: input.bot.chatId, provider: input.provider, project: input.project,
      routeId: input.routeId, pid, processStart: start, startedAt: Date.now(),
      ...(configured ? {} : { start: "suppressed" as const }), ...sessionIdentity(input.project) });
  });
  await notify(input.id, "start", input.bot, sender);
}

export async function finishSession(id: string, reason = "ended", sender: LifecycleSend = send): Promise<void> {
  const record = withStateLock(pathFor(id), () => {
    const record = read(id);
    if (!record || record.end) return undefined;
    record.reason = reason;
    write(record);
    return record;
  });
  if (!record) return;
  const bot = readConfig().bots[record.botName];
  const removeRoute = () => {
    if (!record.routeId) return;
    const routes = fileRoutesByHash(record.botHash);
    routes.remove(record.routeId, { pid: record.pid, processStart: record.processStart });
  };
  removeRoute();
  if (!bot || createHash("sha256").update(bot.token).digest("hex") !== record.botHash || String(bot.chatId) !== String(record.chatId)) {
    withStateLock(pathFor(id), () => { const current = read(id)!; current.end = "suppressed"; write(current); });
    return;
  }
  try { await notify(id, "end", bot, sender); }
  finally { removeRoute(); }
}

export async function sweepSessions(sender: LifecycleSend = send): Promise<void> {
  if (!existsSync(root())) return;
  for (const file of readdirSync(root()).filter((file) => file.endsWith(".json"))) {
    let record: LifecycleSession;
    try { record = JSON.parse(readFileSync(join(root(), file), "utf8")) as LifecycleSession; }
    catch { continue; }
    if (!record.end && !sessionProcessAlive(record)) {
      await finishSession(record.id, "terminated unexpectedly (process exited)", sender);
    }
  }
}

/** Host identification refines a connected MCP lifetime without inventing another termination/start. */
export function identifySession(id: string, provider: string, project: string, routeId?: string) {
  withStateLock(pathFor(id), () => {
    const record = read(id);
    if (record && !record.end) write({ ...record, provider, project, ...(routeId ? { routeId } : {}), ...sessionIdentity(project) });
  });
}
