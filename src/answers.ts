/** Answer events passed from the one Telegram poller to another process's open question. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./registry.ts";
import type { CallbackCtx } from "./telegram.ts";

type Event =
  | { kind: "callback"; payload: string; ctx: CallbackCtx }
  | { kind: "text"; text: string; fromId?: number };

export type AnswerStore = {
  offset(): number | undefined;
  saveOffset(offset: number): void;
  hasQuestions(): boolean;
  register(key: string, deadline: number): void;
  remove(key: string): void;
  take(key: string): Event[];
  callback(requestId: string, payload: string, ctx: CallbackCtx): void;
  textKeys(chatId: number | string): string[];
  text(chatId: number | string, promptId: number | undefined, text: string, fromId?: number): boolean;
};

export const callbackKey = (requestId: string) => `c-${requestId}`;
export const textKey = (chatId: number | string, promptId: number) => `t-${chatId}-${promptId}`;

/** The token is only used to choose a private directory; no event or path contains the token. */
export function fileAnswers(token: string): AnswerStore {
  const root = join(dirname(statePath()), "answers", createHash("sha256").update(token).digest("hex"));
  const path = (key: string) => join(root, key);
  const live = (key: string) => {
    try {
      const { deadline, pid } = JSON.parse(readFileSync(join(path(key), "deadline"), "utf8"));
      if (deadline < Date.now()) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const put = (key: string, event: Event) => {
    if (!live(key)) return false;
    const base = join(path(key), `${Date.now()}-${randomUUID()}`);
    try {
      writeFileSync(`${base}.tmp`, JSON.stringify(event), { mode: 0o600 });
      renameSync(`${base}.tmp`, `${base}.json`);
      return true;
    } catch {
      rmSync(`${base}.tmp`, { force: true });
      return false;
    }
  };
  return {
    offset() {
      try {
        const offset = Number(readFileSync(join(root, "offset"), "utf8"));
        return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
      } catch {
        return undefined;
      }
    },
    saveOffset(offset) {
      const tmp = join(root, `.tmp-${randomUUID()}`);
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(tmp, String(offset), { mode: 0o600 });
        renameSync(tmp, join(root, "offset"));
      } catch {
        rmSync(tmp, { force: true });
        // A crash may replay an update, but an offset write must not stop Telegram polling.
      }
    },
    hasQuestions() {
      try {
        return readdirSync(root).some((key) => (key.startsWith("c-") || key.startsWith("t-")) && live(key));
      } catch {
        return false;
      }
    },
    register(key, deadline) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const tmp = join(root, `.tmp-${randomUUID()}`);
      mkdirSync(tmp, { mode: 0o700 });
      writeFileSync(join(tmp, "deadline"), JSON.stringify({ deadline, pid: process.pid }), { mode: 0o600 });
      renameSync(tmp, path(key));
      // A crashed asker cannot leave a live-looking prompt behind indefinitely.
      for (const old of readdirSync(root)) {
        if ((old.startsWith("c-") || old.startsWith("t-")) && !live(old)) rmSync(path(old), { recursive: true, force: true });
      }
    },
    remove(key) {
      rmSync(path(key), { recursive: true, force: true });
    },
    take(key) {
      if (!live(key)) return [];
      const events: Event[] = [];
      let files: string[];
      try {
        files = readdirSync(path(key)).filter((name) => name.endsWith(".json")).sort();
      } catch {
        return [];
      }
      for (const file of files) {
        const entry = join(path(key), file);
        try {
          events.push(JSON.parse(readFileSync(entry, "utf8")) as Event);
          rmSync(entry, { force: true });
        } catch {
          // A question may have settled and removed its directory while this pump ran.
        }
      }
      return events;
    },
    callback(requestId, payload, ctx) {
      put(callbackKey(requestId), { kind: "callback", payload, ctx });
    },
    textKeys(chatId) {
      try {
        return readdirSync(root).filter((key) => key.startsWith(`t-${chatId}-`) && live(key));
      } catch {
        return [];
      }
    },
    text(chatId, promptId, text, fromId) {
      const prefix = `t-${chatId}-`;
      let available: string[];
      try {
        available = readdirSync(root);
      } catch {
        return false;
      }
      const candidates = promptId === undefined
        ? available.filter((key) => key.startsWith(prefix) && live(key))
        : [textKey(chatId, promptId)];
      return candidates.length === 1 && put(candidates[0], { kind: "text", text, fromId });
    },
  };
}
