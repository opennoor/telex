/** One user-level listener, shared by all projects and host sessions. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, readConfig } from "./config.ts";
import { statePath, touch, release, withStateLock } from "./registry.ts";
import { sessionFor, type BotSession } from "./telegram.ts";
import { fileAnswers } from "./answers.ts";
import { fileInbox, scopedInbox } from "./inbox.ts";
import { fileRoutes } from "./routes.ts";
import { receipt, markExpired } from "./ask.ts";
import { sessionProcessAlive, sweepSessions } from "./lifecycle.ts";
import { processStart } from "./wake.ts";

const daemonPath = () => join(dirname(statePath()), "daemon.json");
type DaemonRecord = { id: string; pid: number; processStart?: string };
const readDaemon = (): DaemonRecord | undefined => {
  try { return JSON.parse(readFileSync(daemonPath(), "utf8")); } catch { return undefined; }
};

/** The short state lock serializes stale-daemon replacement as well as competing fresh starts. */
export function acquireDaemon(): () => void {
  const path = daemonPath();
  const record: DaemonRecord = { id: randomUUID(), pid: process.pid };
  try { record.processStart = processStart(process.pid); } catch { /* PID-only on other platforms */ }
  withStateLock(path, () => {
    const existing = readDaemon();
    if (existing && sessionProcessAlive(existing)) throw new Error(`telex: listener already running (pid ${existing.pid})`);
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  });
  return () => withStateLock(path, () => {
    if (readDaemon()?.id === record.id) unlinkSync(path);
  });
}

export function startDaemon(factory: (token: string, routeId?: string) => BotSession = sessionFor) {
  const unlock = acquireDaemon();
  const active = new Map<string, { session: BotSession; registration: string }>();
  const report = (error: unknown) => process.stderr.write(`telex: listener: ${(error as Error).message}\n`);
  let sweeping = false;
  let queueExpirySeconds = 3600;
  const reconcile = () => {
    const config = Object.keys(readConfig().bots).length ? loadConfig() : { bots: {}, queueExpirySeconds: 3600 };
    queueExpirySeconds = config.queueExpirySeconds;
    const tokens = new Set(Object.values(config.bots).map((bot) => bot.token));
    for (const [token, entry] of active) {
      if (tokens.has(token)) continue;
      entry.session.stop();
      entry.session.setPollingOwner(false);
      release(entry.registration);
      active.delete(token);
    }
    for (const token of tokens) {
      const hash = createHash("sha256").update(token).digest("hex");
      let entry = active.get(token);
      if (!entry) {
        const session = factory(token);
        const routes = fileRoutes(token);
        session.setAnswerStore(fileAnswers(token));
        session.setRouteStore(routes, (route, message) => {
          const inbox = scopedInbox(fileInbox(), `${hash}:${route.id}`);
          inbox.push(String(route.chatId), message, Date.now() + queueExpirySeconds * 1000);
          const client = factory(token, route.id);
          client.setRoute(routes, route);
          client.setInboxStore(inbox);
          void receipt(client, route.chatId, message).catch(report);
        });
        entry = { session, registration: `daemon:${process.pid}:${hash}` };
        active.set(token, entry);
        touch({ session_id: entry.registration, bot: hash, project: dirname(statePath()), repo: "telex-daemon",
          agent: "telex-daemon", pid: process.pid, interval_seconds: 5 });
        session.setPollingOwner(true);
        session.listen();
      }
      for (const bot of Object.values(config.bots).filter((bot) => bot.token === token)) {
        for (const route of fileRoutes(token).active(bot.chatId)) {
          const inbox = scopedInbox(fileInbox(), `${hash}:${route.id}`);
          const expired = inbox.expire(String(route.chatId), Date.now());
          if (expired.length) {
            const client = factory(token, route.id);
            client.setRoute(fileRoutes(token), route);
            markExpired(client, route.chatId, expired);
          }
        }
      }
    }
    if (!sweeping) {
      sweeping = true;
      void sweepSessions().catch(report).finally(() => { sweeping = false; });
    }
  };
  try { reconcile(); } catch (error) {
    for (const entry of active.values()) {
      entry.session.stop();
      entry.session.setPollingOwner(false);
      release(entry.registration);
    }
    unlock();
    throw error;
  }
  const timer = setInterval(() => { try { reconcile(); } catch (error) { report(error); } }, 5000);
  let stopped = false;
  return {
    reconcile,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const entry of active.values()) {
        entry.session.stop();
        entry.session.setPollingOwner(false);
        release(entry.registration);
      }
      unlock();
    },
  };
}

export function runDaemon() {
  const daemon = startDaemon();
  const stop = () => { daemon.stop(); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("exit", () => daemon.stop());
  process.stderr.write("telex: listener running\n");
}
