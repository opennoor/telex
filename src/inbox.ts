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
export type Held = Incoming & { key: string; expires_at?: number };

/** What a BotSession needs of a queue, so tests can keep using a plain in-memory one. */
export type InboxStore = {
  push(key: string, message: Incoming, expiresAt?: number): void;
  take(key: string): Incoming[];
  /** Remove and return whatever outlived its deadline. */
  expire(key: string, now: number): Incoming[];
  /** Record telex's reply to a message, so any process can settle that receipt later. */
  receipt(key: string, messageId: number, receiptId: number): void;
};

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
      closeSync(openSync(lock, "wx"));
      held = true;
      break;
    } catch {
      // A lock left behind by a crash must not wedge every agent on the machine.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch {
        // it went away on its own
      }
      const until = Date.now() + 20;
      while (Date.now() < until);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        unlinkSync(lock);
      } catch {
        // already gone
      }
    }
  }
}

/** The queue every telex process on this machine shares. */
export function fileInbox(): InboxStore {
  const strip = ({ key: _key, expires_at: _expires, ...message }: Held): Incoming => message;
  return {
    push(key, message, expiresAt) {
      withLock(() => {
        const held = read().filter((m) => !(m.key === key && m.message_id === message.message_id));
        const mine = held.filter((m) => m.key === key);
        const others = held.filter((m) => m.key !== key);
        write([...others, ...[...mine, { ...message, key, expires_at: expiresAt }].slice(-LIMIT)]);
      });
    },
    take(key) {
      return withLock(() => {
        const held = read();
        write(held.filter((m) => m.key !== key));
        return held.filter((m) => m.key === key).map(strip);
      });
    },
    expire(key, now) {
      return withLock(() => {
        const held = read();
        const dead = held.filter((m) => m.key === key && m.expires_at !== undefined && now > m.expires_at);
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
  };
}

/** The default: private to one process, which is all a single-agent project ever needed. */
export function memoryInbox(): InboxStore {
  // Holds the very object it was handed: callers stamp a receipt id onto a queued message after
  // Telegram answers, and a copy would silently lose it.
  const held = new Map<string, { message: Incoming; expiresAt?: number }[]>();
  return {
    push(key, message, expiresAt) {
      held.set(key, [...(held.get(key) ?? []), { message, expiresAt }].slice(-LIMIT));
    },
    take(key) {
      const queued = held.get(key) ?? [];
      held.delete(key);
      return queued.map((entry) => entry.message);
    },
    expire(key, now) {
      const queued = held.get(key) ?? [];
      const dead = queued.filter((entry) => entry.expiresAt !== undefined && now > entry.expiresAt);
      if (dead.length) held.set(key, queued.filter((entry) => !dead.includes(entry)));
      return dead.map((entry) => entry.message);
    },
    receipt() {
      // Nothing to do: the caller already holds the object it queued.
    },
  };
}
