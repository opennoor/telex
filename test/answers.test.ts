import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileAnswers } from "../src/answers.ts";
import { ask } from "../src/ask.ts";
import { statePath } from "../src/registry.ts";
import { BotSession, type Update } from "../src/telegram.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await pause(10);
  assert.ok(check(), "expected Telegram call was not made");
}

function fakeSession() {
  const calls: { method: string; params: any; result: any }[] = [];
  let messageId = 100;
  const session = new BotSession(async (method, params) => {
    if (method === "getUpdates") {
      calls.push({ method, params, result: [] });
      await pause(10);
      return [];
    }
    const result = method === "sendMessage" ? { message_id: ++messageId } : true;
    calls.push({ method, params, result });
    return result;
  }, 0);
  return { session, calls };
}

function pair(t: { after: (fn: () => void) => void }) {
  const previous = process.env.TELEX_STATE;
  process.env.TELEX_STATE = join(mkdtempSync(join(tmpdir(), "telex-answers-")), "sessions.json");
  t.after(() => {
    if (previous === undefined) delete process.env.TELEX_STATE;
    else process.env.TELEX_STATE = previous;
  });
  const token = "sensitive-bot-token";
  const owner = fakeSession();
  const asker = fakeSession();
  owner.session.setAnswerStore(fileAnswers(token));
  asker.session.setAnswerStore(fileAnswers(token));
  asker.session.setPollingOwner(false);
  t.after(() => owner.session.stop());
  return { owner, asker, token };
}

const tap = (data: string, updateId: number, fromId = 42, chatId = 7): Update => ({
  update_id: updateId,
  callback_query: { id: `cb${updateId}`, data, from: { id: fromId }, message: { message_id: 101, chat: { id: chatId } } },
});

test("only the owner polls and forwards the authorized button answer to the asking process", async (t) => {
  const { owner, asker, token } = pair(t);
  const pending = ask(asker.session, 7, { project: "P", message: "Deploy?", options: ["Yes"], allowFrom: [42], timeoutSeconds: 2 });
  await until(() => asker.calls.some((c) => c.method === "sendMessage"));
  const data = asker.calls.find((c) => c.method === "sendMessage")!.params.reply_markup.inline_keyboard[0][0].callback_data;
  await until(() => existsSync(join(dirname(statePath()), "answers")));
  assert.equal(readdirSync(join(dirname(statePath()), "answers")).some((name) => name.includes(token)), false);

  owner.session.dispatch(tap(data, 1, 99));
  owner.session.dispatch(tap(data, 2, 42, 8));
  await until(() => asker.calls.filter((c) => c.method === "answerCallbackQuery").length === 2);
  assert.equal(asker.calls.filter((c) => c.method === "editMessageText").length, 0);

  const otherBot = fakeSession();
  otherBot.session.setAnswerStore(fileAnswers(`${token}-other`));
  otherBot.session.dispatch(tap(data, 4));
  await pause(70);
  assert.equal(asker.calls.filter((c) => c.method === "editMessageText").length, 0);

  owner.session.dispatch(tap(data, 3));
  assert.deepEqual(await pending, { status: "answered", response: "Yes", kind: "choice", message_id: 101 });
  assert.equal(asker.calls.filter((c) => c.method === "getUpdates").length, 0);
});

test("owner forwards a reply to the other process without queueing or delivering it twice", async (t) => {
  const { owner, asker } = pair(t);
  const queued: string[] = [];
  owner.session.watch(7, { onQueued: (message) => queued.push(message.text) });
  const pending = ask(asker.session, 7, { project: "P", message: "Name?", expectText: true, allowFrom: [42], timeoutSeconds: 2 });
  await until(() => asker.calls.some((c) => c.params.reply_markup?.inline_keyboard));
  await until(() => existsSync(join(dirname(statePath()), "answers")));
  const data = asker.calls.find((c) => c.params.reply_markup?.inline_keyboard)!.params.reply_markup.inline_keyboard[0][0].callback_data;
  owner.session.dispatch(tap(data, 1));
  await until(() => asker.calls.some((c) => c.params.reply_markup?.force_reply));
  const promptId = asker.calls.find((c) => c.params.reply_markup?.force_reply)!.result.message_id;

  owner.session.dispatch({ update_id: 2, message: { message_id: 9, chat: { id: 7 }, from: { id: 42 }, text: "unrelated", reply_to_message: { message_id: 999 } } });
  owner.session.dispatch({ update_id: 3, message: { message_id: 10, chat: { id: 7 }, from: { id: 99 }, text: "intruder", reply_to_message: { message_id: promptId } } });
  await pause(70);
  assert.equal(asker.calls.filter((c) => c.method === "editMessageText").length, 0);
  owner.session.dispatch({ update_id: 4, message: { message_id: 11, chat: { id: 7 }, from: { id: 42 }, text: "Alice", reply_to_message: { message_id: promptId } } });
  assert.deepEqual(await pending, { status: "answered", response: "Alice", kind: "text", message_id: 101 });
  assert.deepEqual(queued, ["unrelated"]);
  assert.deepEqual(owner.session.take(7).map((m) => m.text), ["unrelated"]);
  assert.deepEqual(owner.session.take(7), []);
  assert.ok(owner.calls.some((c) => c.method === "getUpdates"));
  assert.equal(asker.calls.filter((c) => c.method === "getUpdates").length, 0);
});

test("answers for two asking processes stay with their own questions", async (t) => {
  const { owner, asker, token } = pair(t);
  const other = fakeSession();
  other.session.setAnswerStore(fileAnswers(token));
  other.session.setPollingOwner(false);
  const first = ask(asker.session, 7, { project: "P", message: "First?", options: ["One"], timeoutSeconds: 2 });
  const second = ask(other.session, 7, { project: "P", message: "Second?", options: ["Two"], timeoutSeconds: 2 });
  await until(() => {
    const root = join(dirname(statePath()), "answers");
    if (!existsSync(root)) return false;
    const namespaces = readdirSync(root);
    return namespaces.length === 1 && readdirSync(join(root, namespaces[0])).filter((name) => name.startsWith("c-")).length === 2;
  });
  const firstData = asker.calls.find((c) => c.method === "sendMessage")!.params.reply_markup.inline_keyboard[0][0].callback_data;
  const secondData = other.calls.find((c) => c.method === "sendMessage")!.params.reply_markup.inline_keyboard[0][0].callback_data;
  assert.notEqual(firstData, secondData);
  owner.session.dispatch(tap(secondData, 1));
  assert.deepEqual(await second, { status: "answered", response: "Two", kind: "choice", message_id: 101 });
  assert.equal(asker.calls.filter((c) => c.method === "editMessageText").length, 0);
  owner.session.dispatch(tap(firstData, 2));
  assert.deepEqual(await first, { status: "answered", response: "One", kind: "choice", message_id: 101 });
  assert.equal(other.calls.filter((c) => c.method === "getUpdates").length, 0);
});

test("promotion keeps an answer already forwarded to the former nonowner", async (t) => {
  const { owner, asker } = pair(t);
  const pending = ask(asker.session, 7, { project: "P", message: "Ready?", options: ["Yes"], timeoutSeconds: 2 });
  await until(() => existsSync(join(dirname(statePath()), "answers")));
  const data = asker.calls.find((c) => c.method === "sendMessage")!.params.reply_markup.inline_keyboard[0][0].callback_data;

  owner.session.dispatch(tap(data, 1));
  asker.session.setPollingOwner(true); // before the shared answer reader's next 50ms pass
  assert.deepEqual(await pending, { status: "answered", response: "Yes", kind: "choice", message_id: 101 });
  asker.session.dispatch(tap(data, 2));
  await pause(70);
  assert.equal(asker.calls.filter((c) => c.method === "editMessageText").length, 1);
  assert.equal(asker.calls.filter((c) => c.method === "answerCallbackQuery").length, 1);
});

test("promotion accepts bare text for its one retained question", async (t) => {
  const { asker } = pair(t);
  let received: string | undefined;
  const remove = asker.session.onText(7, 100, (value) => { received = value; }, Date.now() + 2000);
  t.after(remove);
  asker.session.setPollingOwner(true);
  asker.session.dispatch({ update_id: 1, message: { message_id: 101, chat: { id: 7 }, from: { id: 42 }, text: "hello" } });
  assert.equal(received, "hello");
});

test("a replacement owner resumes the last processed Telegram offset", async (t) => {
  const { owner, token } = pair(t);
  owner.session.dispatch({ update_id: 17 });
  const replacement = fakeSession();
  replacement.session.setAnswerStore(fileAnswers(token));
  replacement.session.watch(7);
  t.after(() => replacement.session.stop());
  await until(() => replacement.calls.some((c) => c.method === "getUpdates"));
  assert.equal(replacement.calls.find((c) => c.method === "getUpdates")!.params.offset, 18);
});

test("takeover keeps a live remote question when no offset was recorded yet", async (t) => {
  const { owner, asker } = pair(t);
  const pending = ask(asker.session, 7, { project: "P", message: "Ready?", options: ["Yes"], timeoutSeconds: 2 });
  await until(() => existsSync(join(dirname(statePath()), "answers")));
  owner.session.setPollingOwner(false);
  owner.session.setPollingOwner(true);
  owner.session.watch(7);
  await until(() => owner.calls.some((c) => c.method === "getUpdates"));
  assert.equal(owner.calls.find((c) => c.method === "getUpdates")!.params.offset, 0);
  const data = asker.calls.find((c) => c.method === "sendMessage")!.params.reply_markup.inline_keyboard[0][0].callback_data;
  owner.session.dispatch(tap(data, 1));
  assert.equal((await pending).status, "answered");
});

test("losing ownership cancels an in-flight Telegram poll", async (t) => {
  const { token } = pair(t);
  let polls = 0;
  let aborted = false;
  const session = new BotSession(async (method, params, signal) => {
    if (method !== "getUpdates") return true;
    polls++;
    if (params.offset === -1) return [];
    return await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true }));
  });
  session.setAnswerStore(fileAnswers(token));
  session.watch(7);
  t.after(() => session.stop());
  await until(() => polls === 2);
  session.setPollingOwner(false);
  await until(() => aborted);
  await pause(20);
  assert.equal(polls, 2);
});
