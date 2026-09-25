/**
 * The queue of unprompted user messages, shared by every telex process on one machine.
 *
 * It used to be a field on each process's session object. That is wrong the moment a project runs
 * more than one agent: the process that polls queues the message, and a different process's
 * heartbeat truthfully finds nothing, so the user watches "held" sit there until the holder
 * happens to send something of its own. A message belongs to the bot and chat it arrived on, not
 * to whichever process happened to be listening.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./registry.ts";
import type { Incoming } from "./telegram.ts";

/** A queued message plus the deadline the queueing process gave it. */
export type Held = Incoming & { key: string; expires_at?: number; wake_claim?: string };

/** What a BotSession needs of a queue, so tests can keep using a plain in-memory one. */
export type InboxStore = {
  push(key: string, message: Incoming, expiresAt?: number): void;
  take(key: string): Incoming[];
  /** Remove and return whatever outlived its deadline. */
  expire(key: string, now: number): Incoming[];
  /** Record telex's reply to a message, so any process can settle that receipt later. */
  receipt(key: string, messageId: number, receiptId: number): void;
  /** Reserve one message durably before any terminal input. A claim is never replayed. */
  claim(key: string, id: string, accept: (message: Incoming) => boolean): Incoming | undefined;
  /** Remove only the message confirmed by the matching host prompt hook. */
  ack(key: string, id: string): Incoming | undefined;
  claimed(key: string): Incoming[];
  resolve(key: string, messageId: number, retry: boolean): Incoming | undefined;
};

/** Keep chats on separate bot tokens from collecting each other's messages. */
export function scopedInbox(store: InboxStore, tokenKey: string): InboxStore {
  const key = (chat: string) => `${tokenKey}:${chat}`;
  return {
    push: (chat, message, expiresAt) => store.push(key(chat), message, expiresAt),
    take: (chat) => store.take(key(chat)),
    expire: (chat, now) => store.expire(key(chat), now),
    receipt: (chat, messageId, receiptId) => store.receipt(key(chat), messageId, receiptId),
    claim: (chat, id, accept) => store.claim(key(chat), id, accept),
    ack: (chat, id) => store.ack(key(chat), id),
    claimed: (chat) => store.claimed(key(chat)),
    resolve: (chat, messageId, retry) => store.resolve(key(chat), messageId, retry),
  };
}

/** An agent that never checks in must not grow the queue without bound; oldest go first. */
const LIMIT = 50;

export const inboxPath = () => process.env.TELEX_INBOX ?? join(dirname(statePath()), "inbox.json");

const read = (): Held[] => {
  try {
    const parsed = JSON.parse(readFileSync(inboxPath(), "utf8"));
    return Array.isArray(parsed?.held) ? parsed.held : [];
  } catch {
    return []; // missing or corrupt reads as empty, the same as nothing queued
  }
};

const write = (held: Held[]) => {
  const path = inboxPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ held }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
};

/**
 * Exclusive-create is the portable atomic primitive, and a queue needs one: a read-modify-write
 * racing another can drop a message, and a dropped message is the user's, not ours.
 *
 * ponytail: a bounded synchronous spin. Only the bot's owner pushes and heartbeats are seconds
 * apart, so contention is rare; if that changes, move the store behind an async interface.
 */
function withLock<T>(fn: () => T): T {
  const lock = `${inboxPath()}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 2000;
  let held = false;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lock, "wx");
      held = true;
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if (held) {
        try { unlinkSync(lock); } catch { /* failed acquisition already owns no data */ }
        throw err;
      }
      // A lock left behind by a crash must not wedge every agent on the machine.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) {
          const owner = Number(readFileSync(lock, "utf8"));
          let alive = false;
          try { if (owner > 0) { process.kill(owner, 0); alive = true; } }
          catch (err) { alive = (err as NodeJS.ErrnoException).code === "EPERM"; }
          if (!alive) unlinkSync(lock);
        }
      } catch {
        // it went away on its own
      }
      const until = Date.now() + 20;
      while (Date.now() < until);
    }
  }
  if (!held) throw new Error("telex: inbox lock timed out");
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** The queue every telex process on this machine shares. */
export function fileInbox(): InboxStore {
  const strip = ({ key: _key, expires_at: _expires, wake_claim: _claim, ...message }: Held): Incoming => message;
  return {
    push(key, message, expiresAt) {
      withLock(() => {
        const existing = read();
        if (existing.some((m) => m.key === key && m.message_id === message.message_id && m.wake_claim)) return;
        const held = existing.filter((m) => !(m.key === key && m.message_id === message.message_id));
        const mine = held.filter((m) => m.key === key);
        const others = held.filter((m) => m.key !== key);
        const pending = [...mine.filter((m) => !m.wake_claim), { ...message, key, expires_at: expiresAt }].slice(-LIMIT);
        write([...others, ...mine.filter((m) => m.wake_claim), ...pending]);
      });
    },
    take(key) {
      return withLock(() => {
        const held = read();
        write(held.filter((m) => m.key !== key || m.wake_claim));
        return held.filter((m) => m.key === key && !m.wake_claim).map(strip);
      });
    },
    expire(key, now) {
      return withLock(() => {
        const held = read();
        const dead = held.filter((m) => m.key === key && !m.wake_claim && m.expires_at !== undefined && now > m.expires_at);
        if (dead.length) write(held.filter((m) => !dead.includes(m)));
        return dead.map(strip);
      });
    },
    receipt(key, messageId, receiptId) {
      withLock(() => {
        const held = read();
        const found = held.find((m) => m.key === key && m.message_id === messageId);
        if (!found) return;
        found.receipt_id = receiptId;
        write(held);
      });
    },
    claim(key, id, accept) {
      return withLock(() => {
        const held = read();
        if (held.some((m) => m.key === key && m.wake_claim)) return undefined;
        const found = held.find((m) => m.key === key && !m.wake_claim &&
          (m.expires_at === undefined || Date.now() <= m.expires_at) && accept(strip(m)));
        if (!found) return undefined;
        found.wake_claim = id;
        write(held);
        return strip(found);
      });
    },
    ack(key, id) {
      return withLock(() => {
        const held = read();
        const found = held.find((m) => m.key === key && m.wake_claim === id);
        if (!found) return undefined;
        write(held.filter((m) => m !== found));
        return strip(found);
      });
    },
    claimed(key) {
      return withLock(() => read().filter((m) => m.key === key && m.wake_claim).map(strip));
    },
    resolve(key, messageId, retry) {
      return withLock(() => {
        const held = read();
        const found = held.find((m) => m.key === key && m.message_id === messageId && m.wake_claim);
        if (!found) return undefined;
        if (retry) { delete found.wake_claim; delete found.expires_at; }
        write(retry ? held : held.filter((m) => m !== found));
        return strip(found);
      });
    },
  };
}

/** The default: private to one process, which is all a single-agent project ever needed. */
export function memoryInbox(): InboxStore {
  // Holds the very object it was handed: callers stamp a receipt id onto a queued message after
  // Telegram answers, and a copy would silently lose it.
  const held = new Map<string, { message: Incoming & { wake_claim?: string }; expiresAt?: number }[]>();
  return {
    push(key, message, expiresAt) {
      const queued = held.get(key) ?? [];
      if (queued.some((entry) => entry.message.message_id === message.message_id && entry.message.wake_claim)) return;
      const claimed = queued.filter((entry) => entry.message.wake_claim);
      const pending = queued.filter((entry) => !entry.message.wake_claim && entry.message.message_id !== message.message_id);
      held.set(key, [...claimed, ...[...pending, { message, expiresAt }].slice(-LIMIT)]);
    },
    take(key) {
      const queued = held.get(key) ?? [];
      held.set(key, queued.filter((entry) => entry.message.wake_claim));
      return queued.filter((entry) => !entry.message.wake_claim).map((entry) => entry.message);
    },
    expire(key, now) {
      const queued = held.get(key) ?? [];
      const dead = queued.filter((entry) => !entry.message.wake_claim && entry.expiresAt !== undefined && now > entry.expiresAt);
      if (dead.length) held.set(key, queued.filter((entry) => !dead.includes(entry)));
      return dead.map((entry) => entry.message);
    },
    receipt() {
      // Nothing to do: the caller already holds the object it queued.
    },
    claim(key, id, accept) {
      const queued = held.get(key) ?? [];
      if (queued.some((entry) => entry.message.wake_claim)) return undefined;
      const found = queued.find((entry) => accept(entry.message));
      if (!found) return undefined;
      found.message.wake_claim = id;
      return found.message;
    },
    ack(key, id) {
      const queued = held.get(key) ?? [];
      const found = queued.find((entry) => entry.message.wake_claim === id);
      if (!found) return undefined;
      held.set(key, queued.filter((entry) => entry !== found));
      return found.message;
    },
    claimed(key) {
      return (held.get(key) ?? []).filter((entry) => entry.message.wake_claim).map((entry) => entry.message);
    },
    resolve(key, messageId, retry) {
      const queued = held.get(key) ?? [];
      const found = queued.find((entry) => entry.message.message_id === messageId && entry.message.wake_claim);
      if (!found) return undefined;
      if (retry) { delete found.message.wake_claim; found.expiresAt = undefined; }
      else held.set(key, queued.filter((entry) => entry !== found));
      return found.message;
    },
  };
}
