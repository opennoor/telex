import { type BotSession, type CallbackCtx, type Incoming, TelegramError, escapeHtml, toTelegramHtml, fromMarkdown, stripHtml, MAX_MESSAGE_LEN } from "./telegram.ts";
import { randomUUID } from "node:crypto";

export type AskInput = {
  project: string;
  message: string;
  options?: string[];
  expectText?: boolean;
  timeoutSeconds: number;
  /** Telegram user ids allowed to answer. Empty means anyone in the configured chat. */
  allowFrom?: number[];
};

export type AskResult =
  | { status: "sent"; message_id: number }
  | { status: "answered"; response: string; kind: "choice" | "text"; message_id: number }
  | { status: "timeout"; message_id: number };

const nextRequestId = () => randomUUID();

/** Telegram truncates long inline-button labels, so long choices move into the body as a numbered list. */
const LABEL_LIMIT = 24;

export function compose(input: AskInput): { text: string; buttonLabels: string[] } {
  const options = input.options ?? [];
  const numbered = options.some((o) => o.length > LABEL_LIMIT);
  const list = numbered ? `\n\n${options.map((o, i) => `${i + 1}. ${escapeHtml(o)}`).join("\n")}` : "";
  return {
    text: `<b>${escapeHtml(input.project)}</b>\n\n${fromMarkdown(toTelegramHtml(input.message))}${list}`,
    buttonLabels: numbered ? options.map((_, i) => String(i + 1)) : options,
  };
}

/** Split on line boundaries where possible; the parse-mode fallback covers chunks that break a tag. */
export function chunk(text: string, limit = MAX_MESSAGE_LEN): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit) > limit / 2 ? rest.lastIndexOf("\n", limit) : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}

/** Send, wait for the user, then always leave the message in a settled state. */
export async function ask(session: BotSession, chatId: number | string, input: AskInput): Promise<AskResult> {
  const requestId = nextRequestId();
  const options = input.options ?? [];
  if (options.length && input.expectText) throw new Error("telex: use either options or expect_text, not both");

  const { text, buttonLabels } = compose(input);
  const keyboard = options.length
    ? buttonLabels.map((label, i) => [{ text: label, callback_data: `telex:${requestId}:${i}` }])
    : input.expectText
      ? [[{ text: "✍️ Reply", callback_data: `telex:${requestId}:text` }]]
      : [];

  // Only the final chunk carries the keyboard, so the buttons sit under the whole question.
  const chunks = chunk(text);
  let sent!: { message_id: number };
  for (const [i, part] of chunks.entries()) {
    sent = await send(session, chatId, part, i === chunks.length - 1 ? keyboard : []);
  }
  const messageId = sent.message_id;
  const tail = chunks[chunks.length - 1];
  if (!keyboard.length) return { status: "sent", message_id: messageId };

  const deadline = Date.now() + input.timeoutSeconds * 1000;
  const answer = await waitForAnswer(session, chatId, requestId, options, deadline, input.allowFrom);

  if (!answer) {
    await settle(session, chatId, messageId, tail, "⏳ <i>No response — stale.</i>");
    return { status: "timeout", message_id: messageId };
  }
  await settle(session, chatId, messageId, tail, `✅ <b>${escapeHtml(answer.value)}</b>`);
  return { status: "answered", response: answer.value, kind: answer.kind, message_id: messageId };
}

/** What the user sees under their own message as it moves through the queue. */
const RECEIPT = {
  held: "🕦 <i>Held for the agent's next check-in.</i>",
  delivered: "📬 <i>Delivered to the agent.</i>",
  expired: "🗑️ <i>Expired — the agent never picked this up. Send it again if it still matters.</i>",
  refused: "‼️ <i>Not accepted — no agent has checked in for this project yet.</i>",
} as const;

export type Delivered = { text: string; received_at: string; waited_seconds: number };

/**
 * Telegram gives bots no delivery receipt, so telex sends its own and edits it in place. A project
 * that is not running never posts one at all, which is how the user can tell nobody is listening.
 */
export async function receipt(session: BotSession, chatId: number | string, message: Incoming) {
  const sent = await session.api("sendMessage", {
    chat_id: chatId,
    text: RECEIPT.held,
    parse_mode: "HTML",
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  }).catch(() => undefined);
  if (!sent) return;
  message.receipt_id = sent.message_id;
  // A shared queue holds a copy, so the id has to be written back or no other process could
  // settle this receipt.
  session.recordReceipt(chatId, message.message_id, sent.message_id);
}

function updateReceipt(session: BotSession, chatId: number | string, message: Incoming, text: string) {
  if (message.receipt_id === undefined) return;
  return session.api("editMessageText", {
    chat_id: chatId,
    message_id: message.receipt_id,
    text,
    parse_mode: "HTML",
  }).catch(() => {}); // an unchanged or deleted receipt is not worth failing a heartbeat over
}

export const markExpired = (session: BotSession, chatId: number | string, messages: Incoming[]) => {
  for (const message of messages) void updateReceipt(session, chatId, message, RECEIPT.expired);
};

/** Tell the user their message went nowhere, rather than holding it for an agent that may never come. */
export function refuse(session: BotSession, chatId: number | string, message: Incoming) {
  return session.api("sendMessage", {
    chat_id: chatId,
    text: RECEIPT.refused,
    parse_mode: "HTML",
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  }).catch(() => {});
}

/**
 * One heartbeat: drop whatever the agent left too long, then hand over the rest. Returns
 * immediately — the agent's own interval is the clock, and its silence is what expires a message.
 */
export function heartbeat(session: BotSession, chatId: number | string, now = Date.now()): Delivered[] {
  session.sweepInbox(now);
  return deliver(session, chatId, now);
}

/** Hand the queue to the agent and say so in the chat. */
export function deliver(session: BotSession, chatId: number | string, now = Date.now()): Delivered[] {
  return session.take(chatId).map((message) => {
    void updateReceipt(session, chatId, message, RECEIPT.delivered);
    return {
      text: message.text,
      received_at: new Date(message.received_at).toISOString(),
      waited_seconds: Math.round((now - message.received_at) / 1000),
    };
  });
}

/** An inline keyboard is clickable by anyone who can see it, so authorise the tap, not the send. */
function authorized(ctx: CallbackCtx, chatId: number | string, allowFrom?: number[]) {
  if (String(ctx.chatId) !== String(chatId)) return false;
  return !allowFrom?.length || (ctx.fromId !== undefined && allowFrom.includes(ctx.fromId));
}

async function waitForAnswer(
  session: BotSession,
  chatId: number | string,
  requestId: string,
  options: string[],
  deadline: number,
  allowFrom?: number[],
): Promise<{ value: string; kind: "choice" | "text" } | null> {
  const tap = await until<{ payload: string; ctx: CallbackCtx }>(deadline, (resolve) =>
    session.onCallback(requestId, (payload, ctx) => {
      if (!authorized(ctx, chatId, allowFrom)) {
        void session.api("answerCallbackQuery", {
          callback_query_id: ctx.callbackId,
          text: "⛔ Not your prompt.",
        }).catch(() => {});
        return;
      }
      resolve({ payload, ctx });
    }, deadline),
  );
  if (!tap) return null;
  const toast = (text: string) =>
    session.api("answerCallbackQuery", { callback_query_id: tap.ctx.callbackId, text }).catch(() => {});

  if (tap.payload !== "text") {
    const value = options[Number(tap.payload)];
    await toast(value === undefined ? "" : `✓ ${value.slice(0, 60)}`);
    return value === undefined ? null : { value, kind: "choice" };
  }

  await toast("✍️ Type your answer in the chat.");
  const prompt = await send(session, chatId, "✍️ <i>Reply to this message with your response.</i>", [], {
    force_reply: true,
  });
  let text: string | null;
  try {
    text = await until<string>(deadline, (resolve) =>
      session.onText(chatId, prompt.message_id, (value, fromId) => {
        if (allowFrom?.length && (fromId === undefined || !allowFrom.includes(fromId))) return;
        resolve(value);
      }, deadline),
    );
  } finally {
    await session.api("deleteMessage", { chat_id: chatId, message_id: prompt.message_id }).catch(() => {});
  }
  return text === null ? null : { value: text, kind: "text" };
}

/** Resolve with the first value the subscriber emits, or null once the deadline passes. */
function until<T>(deadline: number, subscribe: (resolve: (v: T) => void) => () => void): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    try {
      unsubscribe = subscribe((v) => finish(v));
      if (done) unsubscribe();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/** Drop the keyboard and stamp the outcome onto the message that carried it. */
async function settle(
  session: BotSession,
  chatId: number | string,
  messageId: number,
  text: string,
  footer: string,
) {
  await session.api("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `${text}\n\n${footer}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {}); // "message is not modified" and friends are not worth failing the answer over
}

/** HTML is Telegram's forgiving parse mode, but agents still emit stray tags — fall back to plain text. */
async function send(
  session: BotSession,
  chatId: number | string,
  text: string,
  keyboard: unknown[],
  extraMarkup: Record<string, unknown> = {},
): Promise<{ message_id: number }> {
  const reply_markup = keyboard.length
    ? { inline_keyboard: keyboard }
    : Object.keys(extraMarkup).length
      ? extraMarkup
      : undefined;
  try {
    return await session.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup });
  } catch (err) {
    if (!(err instanceof TelegramError) || !/parse|entit|tag/i.test(err.description)) throw err;
    return await session.api("sendMessage", { chat_id: chatId, text: stripHtml(text), reply_markup });
  }
}
