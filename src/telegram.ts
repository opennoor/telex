/** Thin Telegram Bot API client plus an on-demand long-poll loop per bot token. */
import { memoryInbox, type InboxStore } from "./inbox.ts";
import { callbackKey, textKey, type AnswerStore } from "./answers.ts";

export type Update = {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
};

export type Fetcher = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;

export class TelegramError extends Error {
  method: string;
  description: string;
  code: number;
  constructor(method: string, description: string, code = 0) {
    super(`telegram ${method} failed: ${description}`);
    this.method = method;
    this.description = description;
    this.code = code;
  }
}

/** Bot tokens appear in API URLs, so they leak through raw fetch errors. */
export const redactToken = (s: string, token: string) => (token ? s.split(token).join("<token>") : s);

export function apiFor(token: string): Fetcher {
  return async function call(method, params, signal, attempt = 0): Promise<any> {
    let body: { ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new Error(redactToken(`telegram ${method} request failed: ${(err as Error).message}`, token));
    }
    if (body.ok) return body.result;
    const retryAfter = body.parameters?.retry_after;
    if (retryAfter !== undefined && attempt < 2) {
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return call(method, params, signal, attempt + 1);
    }
    throw new TelegramError(method, redactToken(body.description ?? "unknown error", token), 0);
  } as Fetcher;
}

/** Telegram's HTML subset only needs these three escaped in text nodes. */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Everything Telegram's HTML parser accepts. Anything else is text, however much it looks like markup. */
const ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "a", "code", "pre", "span", "tg-spoiler", "tg-emoji", "blockquote",
]);

/** Layout tags carry no meaning Telegram can show, but their line breaks do. */
const BLOCK_TAGS =
  /^(?:p|div|ul|ol|table|tbody|thead|tfoot|tr|td|th|h[1-6]|section|article|header|footer|main|nav|figure|figcaption)$/i;

/**
 * Agents write HTML, not Telegram's subset of it. A single <br> used to fail the whole message and
 * drop it to plain text, which then showed every other tag raw — so translate what has an
 * equivalent, drop the layout tags, and escape the rest rather than letting it poison the parse.
 */
export function toTelegramHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<(\/?)([a-z0-9-]+)[^>]*>/gi, (tag, closing: string, name: string) => {
      if (ALLOWED_TAGS.has(name.toLowerCase())) return tag;
      if (BLOCK_TAGS.test(name)) return closing ? "\n" : "";
      return escapeHtml(tag);
    })
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}

/**
 * Agents reach for Markdown by habit, and Telegram renders none of it. Converting the four
 * unambiguous constructs costs nothing and saves a message that would otherwise arrive as
 * asterisks and backticks. Single-asterisk italics are left alone: globs and file names use them.
 */
export function fromMarkdown(text: string): string {
  return text
    .replace(/```[a-z0-9+#-]*\n([\s\S]*?)```/gi, (_, code: string) => `<pre><code>${code.replace(/\n$/, "")}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

/** Last resort when even the sanitised HTML will not parse: readable text beats visible markup. */
export const stripHtml = (text: string) =>
  text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** Telegram counts message length in UTF-16 code units, which is what JS strings already are. */
export const MAX_MESSAGE_LEN = 4000;

export type CallbackCtx = { callbackId: string; fromId?: number; chatId?: number };
type CallbackWaiter = (payload: string, ctx: CallbackCtx) => void;
type TextWaiter = (text: string, fromId?: number) => void;

/** A message the user sent without being asked for one. `receipt_id` is telex's reply to it. */
export type Incoming = { message_id: number; from_id?: number; text: string; received_at: number; receipt_id?: number };

type Watch = {
  allowFrom?: number[];
  /** Gate run before queueing; a false answer means the message is refused, not held. */
  accept?: () => boolean;
  onRefused?: (message: Incoming) => void;
  onQueued?: (message: Incoming) => void;
  /** Fires for messages no heartbeat collected in time. */
  onExpired?: (messages: Incoming[]) => void;
};

/**
 * One session per bot token. Polling runs while a question is open and, once a chat is watched,
 * for the rest of the process's life — a project that is not running simply never answers.
 */
export class BotSession {
  readonly api: Fetcher;
  private readonly pollTimeout: number;
  private offset = 0;
  private backlogSkipped = false;
  private looping = false;
  private pollAbort?: AbortController;
  private callbackWaiters = new Map<string, CallbackWaiter>();
  private textWaiters = new Map<string, TextWaiter>();
  private callbackDeadlines = new Map<string, number>();
  private textDeadlines = new Map<string, number>();
  private answerStore?: AnswerStore;
  private answerTimer?: ReturnType<typeof setInterval>;
  private remoteKeys = new Set<string>();
  private pollingOwner = true;
  private watched = new Map<string, Watch>();
  /** Where queued messages live. Shared across processes in the server; private in tests. */
  private store: InboxStore = memoryInbox();
  private ttl = new Map<string, number>();
  private listening = false;

  constructor(api: Fetcher, pollTimeout = 30) {
    this.api = api;
    this.pollTimeout = pollTimeout;
  }

  setAnswerStore(store: AnswerStore) {
    this.answerStore = store;
    const offset = store.offset();
    if (offset !== undefined) {
      this.offset = Math.max(this.offset, offset);
      this.backlogSkipped = true;
    }
  }

  /** Only the elected process may call getUpdates; other processes read shared answer events. */
  setPollingOwner(owns: boolean) {
    if (!owns && !this.answerStore) throw new Error("telex: shared answer store is required for a non-owner session");
    if (this.pollingOwner === owns) return;
    this.pollingOwner = owns;
    if (!owns) this.pollAbort?.abort();
    if (owns && this.answerStore?.hasQuestions()) this.backlogSkipped = true;
    for (const [id, deadline] of this.callbackDeadlines) {
      const key = callbackKey(id);
      if (!owns && !this.remoteKeys.has(key)) {
        this.answerStore?.register(key, deadline);
        this.remoteKeys.add(key);
      }
    }
    for (const [key, deadline] of this.textDeadlines) {
      if (!owns && !this.remoteKeys.has(key)) {
        this.answerStore?.register(key, deadline);
        this.remoteKeys.add(key);
      }
    }
    if (owns) {
      if (this.listening || !this.idle) this.ensureLoop();
    }
    this.ensureAnswerLoop();
  }

  onCallback(requestId: string, fn: CallbackWaiter, deadline: number): () => void {
    const key = callbackKey(requestId);
    if (!this.pollingOwner) {
      this.answerStore!.register(key, deadline);
      this.remoteKeys.add(key);
    }
    this.callbackWaiters.set(requestId, fn);
    this.callbackDeadlines.set(requestId, deadline);
    if (this.pollingOwner) this.ensureLoop();
    else this.ensureAnswerLoop();
    return () => {
      this.callbackWaiters.delete(requestId);
      this.callbackDeadlines.delete(requestId);
      if (this.remoteKeys.delete(key)) this.answerStore?.remove(key);
    };
  }

  onText(chatId: number | string, promptId: number, fn: TextWaiter, deadline: number): () => void {
    const key = textKey(chatId, promptId);
    if (!this.pollingOwner) {
      this.answerStore!.register(key, deadline);
      this.remoteKeys.add(key);
    }
    this.textWaiters.set(key, fn);
    this.textDeadlines.set(key, deadline);
    if (this.pollingOwner) this.ensureLoop();
    else this.ensureAnswerLoop();
    return () => {
      this.textWaiters.delete(key);
      this.textDeadlines.delete(key);
      if (this.remoteKeys.delete(key)) this.answerStore?.remove(key);
    };
  }

  /**
   * Take an interest in a chat and keep polling for the life of the process. Being alive is what
   * makes a project reachable: if nothing polls, nothing acknowledges, and nothing was delivered.
   */
  watch(chatId: number | string, options: Watch = {}) {
    this.watched.set(String(chatId), options);
    this.listening = true;
    this.ensureLoop();
  }

  /** Stop the permanent poll. The loop still runs out whatever question is currently open. */
  stop() {
    this.listening = false;
    this.watched.clear();
    this.ttl.clear();
  }

  /**
   * How long a message may sit unclaimed. Set from the agent's heartbeat interval, so until it
   * checks in for the first time telex has no idea how long "too long" is and nothing expires.
   */
  setInboxTtl(chatId: number | string, ms: number) {
    this.ttl.set(String(chatId), ms);
  }

  /**
   * Queue somewhere every telex process can reach. One process polls and another one heartbeats,
   * so a queue private to one of them leaves the user's message held by an agent that is not the
   * one checking in.
   */
  setInboxStore(store: InboxStore) {
    this.store = store;
  }

  /** Hand over everything held for this chat. */
  take(chatId: number | string): Incoming[] {
    return this.store.take(String(chatId));
  }

  /** Remember telex's reply to a message, so whichever process settles it can find the receipt. */
  recordReceipt(chatId: number | string, messageId: number, receiptId: number) {
    this.store.receipt(String(chatId), messageId, receiptId);
  }

  private get idle() {
    return this.callbackWaiters.size === 0 && this.textWaiters.size === 0;
  }

  private ensureLoop() {
    if (!this.pollingOwner || this.looping) return;
    this.looping = true;
    void this.loop().finally(() => {
      this.looping = false;
      if (this.pollingOwner && (this.listening || !this.idle)) this.ensureLoop();
    });
  }

  private ensureAnswerLoop() {
    if (!this.answerStore || this.answerTimer || this.remoteKeys.size === 0) return;
    // ponytail: one 50ms filesystem poll per process; use IPC if question volume grows.
    this.answerTimer = setInterval(() => {
      if (this.remoteKeys.size === 0) {
        clearInterval(this.answerTimer);
        this.answerTimer = undefined;
        return;
      }
      for (const [id, fn] of this.callbackWaiters) {
        if (!this.remoteKeys.has(callbackKey(id))) continue;
        for (const event of this.answerStore!.take(callbackKey(id))) {
          if (event.kind === "callback") fn(event.payload, event.ctx);
        }
      }
      for (const [key, fn] of this.textWaiters) {
        if (!this.remoteKeys.has(key)) continue;
        for (const event of this.answerStore!.take(key)) {
          if (event.kind === "text") fn(event.text, event.fromId);
        }
      }
    }, 50);
  }

  /**
   * Messages the user sent before we asked anything must not be read as an answer,
   * so the first poll of a process discards whatever is queued.
   */
  private async skipBacklog() {
    if (this.backlogSkipped) return;
    this.backlogSkipped = true;
    const controller = new AbortController();
    this.pollAbort = controller;
    const updates: Update[] = await this.api("getUpdates", { offset: -1, timeout: 0 }, controller.signal).catch(() => []);
    if (this.pollAbort === controller) this.pollAbort = undefined;
    if (!this.pollingOwner) return;
    for (const u of updates) this.offset = Math.max(this.offset, u.update_id + 1);
    this.answerStore?.saveOffset(this.offset);
  }

  private async loop() {
    await this.skipBacklog();
    while (this.pollingOwner && (this.listening || !this.idle)) {
      let updates: Update[];
      const controller = new AbortController();
      this.pollAbort = controller;
      try {
        updates = await this.api("getUpdates", {
          offset: this.offset,
          timeout: this.pollTimeout,
          allowed_updates: ["message", "callback_query"],
        }, controller.signal);
      } catch (err) {
        if (!this.pollingOwner) break;
        if (isPollingConflict(err)) {
          process.stderr.write(
            "telex: getUpdates conflict — another process is polling this bot token. " +
              "Give telex its own bot, or stop the other poller.\n",
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      } finally {
        if (this.pollAbort === controller) this.pollAbort = undefined;
      }
      if (!this.pollingOwner) break;
      for (const u of updates) this.dispatch(u);
      this.sweepInbox();
    }
  }

  /** Exposed for tests: route one update to whoever is waiting for it. */
  dispatch(u: Update) {
    this.offset = Math.max(this.offset, u.update_id + 1);
    this.route(u);
    if (this.pollingOwner) this.answerStore?.saveOffset(this.offset);
  }

  private route(u: Update) {
    const cq = u.callback_query;
    if (cq?.data?.startsWith("telex:")) {
      const [, requestId, payload] = cq.data.split(":");
      const ctx = {
        callbackId: cq.id,
        fromId: cq.from?.id,
        chatId: cq.message?.chat.id,
      };
      const waiter = this.callbackWaiters.get(requestId);
      if (waiter) waiter(payload ?? "", ctx);
      else this.answerStore?.callback(requestId, payload ?? "", ctx);
      return;
    }
    const msg = u.message;
    // Slash commands stay available to whatever else the user runs against this bot.
    if (msg?.text === undefined || msg.text.startsWith("/")) return;
    const key = String(msg.chat.id);
    if (msg.reply_to_message) {
      const answering = this.textWaiters.get(textKey(key, msg.reply_to_message.message_id));
      if (answering) return answering(msg.text, msg.from?.id);
      if (this.answerStore?.text(key, msg.reply_to_message.message_id, msg.text, msg.from?.id)) return;
    } else {
      // ponytail: bare text may answer an unrelated lone prompt; require reply metadata once clients reliably supply it.
      const waiting = [...this.textWaiters].filter(([candidate]) => candidate.startsWith(`t-${key}-`));
      const remote = this.answerStore?.textKeys(key) ?? [];
      if (new Set([...waiting.map(([candidate]) => candidate), ...remote]).size === 1) {
        if (waiting.length) return waiting[0][1](msg.text, msg.from?.id);
        if (this.answerStore?.text(key, undefined, msg.text, msg.from?.id)) return;
      }
    }
    this.queue(key, msg);
  }

  /** Nobody asked for this one, so hold it rather than let it answer whatever gets asked next. */
  private queue(key: string, msg: NonNullable<Update["message"]>, now = Date.now()) {
    const watch = this.watched.get(key);
    if (!watch) return;
    if (watch.allowFrom?.length && !(msg.from && watch.allowFrom.includes(msg.from.id))) return;
    const message: Incoming = { message_id: msg.message_id, from_id: msg.from?.id, text: msg.text!, received_at: now };
    if (watch.accept && !watch.accept()) return watch.onRefused?.(message);
    // The deadline is fixed when the message is queued, so any process can expire it without
    // knowing whose interval set it. Before an agent declares one there is no deadline at all.
    const ttl = this.ttl.get(key);
    this.store.push(key, message, ttl === undefined ? undefined : now + ttl);
    watch.onQueued?.(message);
  }

  /**
   * Drop whatever outlived the TTL. Runs on every poll, so a message expires even when the agent
   * has stopped checking in entirely — which is exactly when the user most needs telling.
   */
  sweepInbox(now = Date.now()) {
    for (const [key, watch] of this.watched) {
      const expired = this.store.expire(key, now);
      if (expired.length) watch.onExpired?.(expired);
    }
  }
}

export const isPollingConflict = (err: unknown) =>
  err instanceof TelegramError && /conflict|terminated by other/i.test(err.description);

const sessions = new Map<string, BotSession>();
export const sessionFor = (token: string) =>
  sessions.get(token) ?? (sessions.set(token, new BotSession(apiFor(token))), sessions.get(token)!);
