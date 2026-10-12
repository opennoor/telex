import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileRoutes, type RouteRegistration } from "../src/routes.ts";
import { BotSession, type Incoming, type Update } from "../src/telegram.ts";
import { memoryInbox, scopedInbox } from "../src/inbox.ts";
import { fileAnswers } from "../src/answers.ts";

function isolated(t: { after: (fn: () => void) => void }) {
  const previous = process.env.TELEX_STATE;
  process.env.TELEX_STATE = join(mkdtempSync(join(tmpdir(), "telex-routes-")), "sessions.json");
  t.after(() => { if (previous === undefined) delete process.env.TELEX_STATE; else process.env.TELEX_STATE = previous; });
}
const route = (id: string, overrides: Partial<RouteRegistration> = {}): RouteRegistration => ({
  id, botName: "work", chatId: 7, provider: "codex", repo: "/repo", branch: id, worktree: `/trees/${id}`, allowFrom: [42], ...overrides,
});
const message = (id: number, text: string, reply?: number, from = 42): Update => ({ update_id: id, message: {
  message_id: id, chat: { id: 7 }, from: { id: from }, text, ...(reply === undefined ? {} : { reply_to_message: { message_id: reply } }),
} });
function fake() {
  const calls: { method: string; params: any }[] = [];
  let id = 100;
  const session = new BotSession(async (method, params) => {
    calls.push({ method, params });
    return method === "sendMessage" ? { message_id: ++id } : true;
  });
  return { session, calls };
}

test("all outgoing messages identify their bot, provider, session, repo, branch and worktree; replies survive listener restart", async (t) => {
  isolated(t);
  const client = fake();
  client.session.setRoute(fileRoutes("token"), route("one"));
  const sent = await client.session.api("sendMessage", { chat_id: 7, text: "Hello", parse_mode: "HTML" });
  await client.session.api("editMessageText", { chat_id: 7, message_id: sent.message_id, text: "Updated" });
  for (const call of client.calls) {
    for (const value of ["work", "codex", "session one", "/repo", "one", "/trees/one"]) assert.ok(call.params.text.includes(value));
  }
  const routed: string[] = [];
  const restarted = fake();
  restarted.session.setRouteStore(fileRoutes("token"), (destination, incoming) => routed.push(`${destination.id}:${incoming.text}`));
  fileRoutes("token").register(route("two"));
  restarted.session.dispatch(message(1, "for one", sent.message_id));
  restarted.session.dispatch(message(2, "intruder", sent.message_id, 99));
  assert.deepEqual(routed, ["one:for one"]);
  fileRoutes("token").remove("one");
  restarted.session.dispatch(message(3, "stale", sent.message_id));
  assert.deepEqual(routed, ["one:for one"]);
  assert.match(restarted.calls.at(-1)!.params.text, /stale or unknown/);
});

test("concurrent routes require an explicit selection, bound to its user and chat and consumable once across restart", (t) => {
  isolated(t);
  const store = fileRoutes("token");
  store.register(route("one"));
  store.register(route("two"));
  const first = fake();
  const delivered: string[] = [];
  first.session.setRouteStore(store, (destination, incoming) => delivered.push(`${destination.id}:${incoming.text}`));
  first.session.dispatch(message(1, "choose me"));
  assert.equal(delivered.length, 0);
  const keyboard = first.calls[0].params.reply_markup.inline_keyboard;
  assert.equal(keyboard.length, 2);
  const data = keyboard[1][0].callback_data;
  const next = fake();
  next.session.setRouteStore(fileRoutes("token"), (destination, incoming) => delivered.push(`${destination.id}:${incoming.text}`));
  const tap = (fromId: number, chatId = 7): Update => ({ update_id: 2, callback_query: { id: "tap", data, from: { id: fromId }, message: { message_id: 101, chat: { id: chatId } } } });
  next.session.dispatch(tap(99));
  next.session.dispatch(tap(42, 8));
  assert.equal(delivered.length, 0);
  next.session.dispatch(tap(42));
  assert.deepEqual(delivered, ["two:choose me"]);
  next.session.dispatch(tap(42));
  assert.deepEqual(delivered, ["two:choose me"]);
  assert.match(next.calls.at(-1)!.params.text, /stale/);
});

test("chat, token, expiry and session inbox scopes cannot cross destinations", (t) => {
  isolated(t);
  const store = fileRoutes("token");
  store.register(route("one"));
  store.register(route("two", { chatId: 8 }));
  store.register(route("expired", { expiresAt: Date.now() - 1 }));
  assert.deepEqual(store.active(7).map((r) => r.id), ["one"]);
  assert.deepEqual(fileRoutes("other-token").active(7), []);
  const inbox = memoryInbox();
  const one = scopedInbox(inbox, "bot:one");
  const two = scopedInbox(inbox, "bot:two");
  const listener = fake();
  listener.session.setRouteStore(store, (destination, incoming) => scopedInbox(inbox, `bot:${destination.id}`).push("7", incoming));
  listener.session.dispatch(message(1, "authorized"));
  listener.session.dispatch(message(2, "intruder", undefined, 99));
  assert.deepEqual(two.take("7"), []);
  assert.deepEqual(one.take("7").map((m) => m.text), ["authorized"]);
  assert.deepEqual(one.take("7"), []);
});

test("unknown question callbacks reject clearly instead of reaching a session", (t) => {
  isolated(t);
  const listener = fake();
  listener.session.setAnswerStore(fileAnswers("token"));
  listener.session.dispatch({ update_id: 1, callback_query: { id: "old", data: "telex:old:0", from: { id: 42 }, message: { message_id: 1, chat: { id: 7 } } } });
  assert.equal(listener.calls[0].method, "answerCallbackQuery");
  assert.match(listener.calls[0].params.text, /stale/);
});

test("a selection whose destination expires is rejected without falling back", (t) => {
  isolated(t);
  const store = fileRoutes("token");
  const incoming: Incoming = { message_id: 1, from_id: 42, text: "secret", received_at: Date.now() };
  store.register(route("one"));
  store.register(route("two"));
  const selection = store.select(7, incoming, store.active(7));
  store.remove("one");
  assert.equal(fileRoutes("token").selection(selection, 0, 7, 42), undefined);
  assert.equal(store.selection(selection, 0, 8, 42), undefined);
  assert.equal(store.selection(selection, 0, 7, 99), undefined);
});

test("the per-token polling lease excludes another live process session and hands off cleanly", (t) => {
  isolated(t);
  const first = fileAnswers("token");
  const second = fileAnswers("token");
  assert.equal(first.claimPolling(), true);
  assert.equal(second.claimPolling(), false);
  assert.equal(first.claimPolling(), true);
  first.releasePolling();
  assert.equal(second.claimPolling(), true);
  second.releasePolling();
});

test("a live question becomes stale as soon as its route ends", (t) => {
  isolated(t);
  const routes = fileRoutes("token");
  routes.register(route("one"));
  const answers = fileAnswers("token");
  answers.register("c-existing", Date.now() + 60_000, "one");
  routes.remove("one");
  const listener = fake();
  listener.session.setAnswerStore(answers);
  listener.session.dispatch({ update_id: 1, callback_query: { id: "ended", data: "telex:existing:0", from: { id: 42 }, message: { message_id: 1, chat: { id: 7 } } } });
  assert.match(listener.calls[0].params.text, /stale/);
  assert.deepEqual(answers.take("c-existing"), []);
});

test("dead or reused process destinations cannot receive replies", (t) => {
  isolated(t);
  const routes = fileRoutes("token");
  routes.register(route("dead", { pid: 2 ** 22 }));
  routes.register(route("reused", { pid: process.pid, processStart: "not-current" }));
  assert.equal(routes.get("dead"), undefined);
  assert.equal(routes.get("reused"), undefined);
  assert.deepEqual(routes.active(7), []);
});

test("long identified messages stay within Telegram limits and keep buttons only on the last part", async (t) => {
  isolated(t);
  const client = fake();
  client.session.setRoute(fileRoutes("token"), route("one", { repo: "&".repeat(200), worktree: "/long/".repeat(100) }));
  await client.session.api("sendMessage", { chat_id: 7, text: "body ".repeat(2000), parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "telex:q:0" }]] } });
  assert.ok(client.calls.length > 1);
  for (const [index, call] of client.calls.entries()) {
    assert.ok(call.params.text.length <= 4000);
    assert.match(call.params.text, /session one/);
    assert.equal(Boolean(call.params.reply_markup), index === client.calls.length - 1);
    assert.equal(fileRoutes("token").message(7, index + 101)?.id, "one");
  }
});


test("new and old incomplete polling leases recover without stealing a live owner", (t) => {
  isolated(t);
  const root = join(dirname(process.env.TELEX_STATE!), "answers", createHash("sha256").update("token").digest("hex"));
  mkdirSync(root, { recursive: true });
  const lock = join(root, "polling");
  for (const age of [0, 60_000]) {
    for (const incomplete of ["", "{", "null", '{"pid":0}', '{"pid":"invalid"}']) {
      writeFileSync(lock, incomplete);
      const stamp = new Date(Date.now() - age);
      utimesSync(lock, stamp, stamp);
      const recovered = fileAnswers("token");
      assert.equal(recovered.claimPolling(), false, "first attempt clears the incomplete lease");
      assert.equal(recovered.claimPolling(), true, "the next attempt acquires the recovered lease");
      assert.equal(fileAnswers("token").claimPolling(), false, "a valid live owner retains its lease");
      recovered.releasePolling();
    }
  }
});
