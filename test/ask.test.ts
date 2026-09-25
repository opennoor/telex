import { test } from "node:test";
import assert from "node:assert/strict";
import { BotSession, TelegramError, toTelegramHtml, fromMarkdown, type Update } from "../src/telegram.ts";
import { ask, chunk, compose, receipt, refuse, heartbeat, markExpired } from "../src/ask.ts";

/** Fake Bot API: records calls, answers getUpdates with nothing so we can inject updates by hand. */
function fakeSession() {
  const calls: { method: string; params: any; result: any }[] = [];
  let messageId = 100;
  const session = new BotSession(async (method, params) => {
    if (method === "getUpdates") return await new Promise((r) => setTimeout(() => r([]), 10));
    const result = method === "sendMessage" ? { message_id: ++messageId } : true;
    calls.push({ method, params, result });
    return result;
  }, 0);
  return { session, calls, last: (m: string) => [...calls].reverse().find((c) => c.method === m) };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

const callbackUpdate = (data: string, from = 42, chat = 7): Update => ({
  update_id: 1,
  callback_query: { id: "cb1", data, from: { id: from }, message: { message_id: 101, chat: { id: chat } } },
});

test("button choice is returned and the message is settled without a keyboard", async () => {
  const { session, calls, last } = fakeSession();
  const pending = ask(session, 7, { project: "Telex", message: "Deploy?", options: ["Yes", "No"], timeoutSeconds: 5 });
  await tick();

  const keyboard = calls[0].params.reply_markup.inline_keyboard;
  assert.equal(calls[0].params.parse_mode, "HTML");
  assert.match(calls[0].params.text, /^<b>Telex<\/b>/);
  session.dispatch(callbackUpdate(keyboard[1][0].callback_data));

  assert.deepEqual(await pending, { status: "answered", response: "No", kind: "choice", message_id: 101 });
  assert.deepEqual(last("editMessageText")!.params.reply_markup, { inline_keyboard: [] });
  assert.match(last("editMessageText")!.params.text, /✅ <b>No<\/b>/);
});

test("free-text reply is captured after the Reply button", async () => {
  const { session, calls, last } = fakeSession();
  const pending = ask(session, 7, { project: "Telex", message: "Name?", expectText: true, timeoutSeconds: 5 });
  await tick();

  session.dispatch(callbackUpdate(calls[0].params.reply_markup.inline_keyboard[0][0].callback_data));
  await tick();
  assert.equal(last("sendMessage")!.params.reply_markup.force_reply, true);

  session.dispatch({ update_id: 2, message: { message_id: 9, chat: { id: 7 }, text: "telex", reply_to_message: { message_id: 102 } } });
  assert.deepEqual(await pending, { status: "answered", response: "telex", kind: "text", message_id: 101 });
  assert.equal(last("deleteMessage")!.params.message_id, 102);
});

test("plain text still answers when only one prompt is open", async () => {
  const { session, calls } = fakeSession();
  const pending = ask(session, 7, { project: "Telex", message: "Name?", expectText: true, timeoutSeconds: 5 });
  await tick();
  session.dispatch(callbackUpdate(calls[0].params.reply_markup.inline_keyboard[0][0].callback_data));
  await tick();

  session.dispatch({ update_id: 2, message: { message_id: 9, chat: { id: 7 }, text: "telex" } });
  assert.deepEqual(await pending, { status: "answered", response: "telex", kind: "text", message_id: 101 });
});

test("text replying to another message stays in the inbox, then the prompt reply answers", async (t) => {
  const { session, calls } = fakeSession();
  t.after(() => session.stop());
  watched(session);
  const pending = ask(session, 7, { project: "Telex", message: "Name?", expectText: true, timeoutSeconds: 5 });
  await tick();
  session.dispatch(callbackUpdate(calls[0].params.reply_markup.inline_keyboard[0][0].callback_data));
  await tick();

  session.dispatch({ update_id: 2, message: { message_id: 9, chat: { id: 7 }, from: { id: 42 }, text: "unrelated", reply_to_message: { message_id: 999 } } });
  await tick();
  assert.deepEqual(session.take(7).map((m) => m.text), ["unrelated"]);
  assert.equal(calls.filter((c) => c.method === "editMessageText").length, 0);

  session.dispatch({ update_id: 3, message: { message_id: 10, chat: { id: 7 }, from: { id: 42 }, text: "answer", reply_to_message: { message_id: 102 } } });
  assert.deepEqual(await pending, { status: "answered", response: "answer", kind: "text", message_id: 101 });
});

test("two text prompts in one chat keep their replies separate", async () => {
  const { session, calls } = fakeSession();
  const first = ask(session, 7, { project: "Telex", message: "First?", expectText: true, timeoutSeconds: 5 });
  const second = ask(session, 7, { project: "Telex", message: "Second?", expectText: true, timeoutSeconds: 5 });
  await tick();
  const questions = calls.filter((c) => c.params.reply_markup?.inline_keyboard);
  session.dispatch(callbackUpdate(questions[0].params.reply_markup.inline_keyboard[0][0].callback_data));
  session.dispatch({ ...callbackUpdate(questions[1].params.reply_markup.inline_keyboard[0][0].callback_data), update_id: 2 });
  await tick();
  const prompts = calls.filter((c) => c.params.reply_markup?.force_reply);
  assert.equal(prompts.length, 2);

  session.dispatch({ update_id: 3, message: { message_id: 11, chat: { id: 7 }, text: "second", reply_to_message: { message_id: prompts[1].result.message_id } } });
  session.dispatch({ update_id: 4, message: { message_id: 12, chat: { id: 7 }, text: "first", reply_to_message: { message_id: prompts[0].result.message_id } } });
  assert.deepEqual(await first, { status: "answered", response: "first", kind: "text", message_id: 101 });
  assert.deepEqual(await second, { status: "answered", response: "second", kind: "text", message_id: 102 });
});

test("no answer before the deadline marks the message stale", async () => {
  const { session, last } = fakeSession();
  const result = await ask(session, 7, { project: "Telex", message: "Deploy?", options: ["Yes"], timeoutSeconds: 0.05 as number });
  assert.deepEqual(result, { status: "timeout", message_id: 101 });
  assert.match(last("editMessageText")!.params.text, /stale/);
  assert.deepEqual(last("editMessageText")!.params.reply_markup, { inline_keyboard: [] });
});

test("HTML is escaped in the project heading", async () => {
  const { session, calls } = fakeSession();
  await ask(session, 7, { project: "a<b>&c", message: "hi", timeoutSeconds: 5 });
  assert.match(calls[0].params.text, /^<b>a&lt;b&gt;&amp;c<\/b>/);
});

test("a tap from an unlisted user is rejected and the question stays open", async () => {
  const { session, calls, last } = fakeSession();
  const pending = ask(session, 7, {
    project: "Telex", message: "Deploy?", options: ["Yes"], timeoutSeconds: 5, allowFrom: [42],
  });
  await tick();
  const data = calls[0].params.reply_markup.inline_keyboard[0][0].callback_data;

  session.dispatch(callbackUpdate(data, 99));
  await tick();
  assert.match(last("answerCallbackQuery")!.params.text, /Not your prompt/);
  assert.equal(last("editMessageText"), undefined);

  session.dispatch({ ...callbackUpdate(data, 42), update_id: 2 });
  assert.equal((await pending).status, "answered");
});

test("a callback without the question's chat cannot answer", async () => {
  const { session, calls } = fakeSession();
  const pending = ask(session, 7, { project: "Telex", message: "Deploy?", options: ["Yes"], timeoutSeconds: 5 });
  await tick();
  const data = calls[0].params.reply_markup.inline_keyboard[0][0].callback_data;
  session.dispatch({ ...callbackUpdate(data), callback_query: { id: "missing", data, from: { id: 42 } } });
  session.dispatch({ ...callbackUpdate(data, 42, 8), update_id: 2 });
  await tick();
  assert.equal(calls.filter((c) => c.method === "editMessageText").length, 0);
  session.dispatch({ ...callbackUpdate(data), update_id: 3 });
  assert.equal((await pending).status, "answered");
});

test("a text reply from an unlisted user is ignored", async () => {
  const { session, calls } = fakeSession();
  const pending = ask(session, 7, {
    project: "Telex", message: "Name?", expectText: true, timeoutSeconds: 0.3 as number, allowFrom: [42],
  });
  await tick();
  session.dispatch(callbackUpdate(calls[0].params.reply_markup.inline_keyboard[0][0].callback_data, 42));
  await tick();
  session.dispatch({ update_id: 2, message: { message_id: 9, chat: { id: 7 }, from: { id: 99 }, text: "nope" } });
  assert.equal((await pending).status, "timeout");
});

test("slash commands are not swallowed as an answer", async () => {
  const { session, calls } = fakeSession();
  const pending = ask(session, 7, { project: "Telex", message: "Name?", expectText: true, timeoutSeconds: 0.3 as number });
  await tick();
  session.dispatch(callbackUpdate(calls[0].params.reply_markup.inline_keyboard[0][0].callback_data));
  await tick();
  session.dispatch({ update_id: 2, message: { message_id: 9, chat: { id: 7 }, text: "/stop" } });
  assert.equal((await pending).status, "timeout");
});

test("long choices move into the body and the buttons become digits", () => {
  const { text, buttonLabels } = compose({
    project: "P", message: "pick", timeoutSeconds: 1,
    options: ["short", "a label that is comfortably longer than the button limit"],
  });
  assert.deepEqual(buttonLabels, ["1", "2"]);
  assert.match(text, /1\. short/);
});

test("oversized messages split on line breaks and keep the keyboard on the last part", async () => {
  const { session, calls } = fakeSession();
  const long = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
  await ask(session, 7, { project: "Telex", message: long, timeoutSeconds: 5 });
  const sends = calls.filter((c) => c.method === "sendMessage");
  assert.ok(sends.length > 1);
  for (const s of sends) assert.ok(s.params.text.length <= 4000, `chunk too long: ${s.params.text.length}`);
  assert.deepEqual(chunk("aaa\nbbb", 5), ["aaa", "bbb"]);
});

const userSaid = (text: string, from = 42, id = 5): Update => ({
  update_id: 1,
  message: { message_id: id, chat: { id: 7 }, from: { id: from }, text },
});

/** Wires a watched chat the way the server does, so the receipts are the real ones. */
function watched(session: BotSession, allowFrom?: number[], accept = () => true) {
  const seen: string[] = [];
  session.watch(7, {
    allowFrom,
    accept,
    onRefused: (message) => void refuse(session, 7, message),
    onQueued: (message) => {
      seen.push(message.text);
      void receipt(session, 7, message);
    },
    onExpired: (messages) => markExpired(session, 7, messages),
  });
  return seen;
}

test("an unprompted message is held for the agent and the user is told nothing is asking", async (t) => {
  const { session, last } = fakeSession();
  t.after(() => session.stop());
  const seen = watched(session);

  session.dispatch(userSaid("deploy it"));
  await tick();

  assert.deepEqual(seen, ["deploy it"]);
  assert.match(last("sendMessage")!.params.text, /held/i);
  assert.equal(last("sendMessage")!.params.reply_parameters.message_id, 5);
  assert.deepEqual(session.take(7).map((m) => m.text), ["deploy it"]);
  assert.deepEqual(session.take(7), []);
});

test("a held message does not answer the next question", async (t) => {
  const { session, calls } = fakeSession();
  t.after(() => session.stop());
  watched(session);
  session.dispatch(userSaid("deploy it"));
  await tick();

  const pending = ask(session, 7, { project: "P", message: "Name?", expectText: true, timeoutSeconds: 0.3 as number });
  await tick();
  const question = calls.find((c) => c.params.reply_markup?.inline_keyboard)!;
  session.dispatch(callbackUpdate(question.params.reply_markup.inline_keyboard[0][0].callback_data));
  assert.equal((await pending).status, "timeout");
});

test("a heartbeat delivers what was said and edits the receipt to say so", async (t) => {
  const { session, last, calls } = fakeSession();
  t.after(() => session.stop());
  watched(session);

  session.dispatch(userSaid("what is the status?"));
  await tick();
  const receiptId = last("sendMessage")!.result.message_id;

  session.setInboxTtl(7, 180_000);
  const delivered = heartbeat(session, 7);
  await tick();
  assert.deepEqual(delivered.map((m) => m.text), ["what is the status?"]);
  const edit = last("editMessageText")!;
  assert.equal(edit.params.message_id, receiptId);
  assert.match(edit.params.text, /Delivered/);

  // Nothing is left behind for the next beat.
  assert.deepEqual(heartbeat(session, 7), []);
  assert.equal(calls.filter((c) => c.method === "editMessageText").length, 1);
});

test("a message nobody collects within three beats is expired and dropped", async (t) => {
  const { session, last } = fakeSession();
  t.after(() => session.stop());
  watched(session);

  const t0 = Date.now();
  session.setInboxTtl(7, 30_000); // a 10s interval, three beats
  session.dispatch(userSaid("still there?"));
  await tick();

  // Two beats late is still within reach...
  assert.deepEqual(heartbeat(session, 7, t0 + 20_000).map((m) => m.text), ["still there?"]);

  session.dispatch({ ...userSaid("hello?"), update_id: 2 });
  await tick();
  // ...but past three, the user is told rather than left wondering.
  assert.deepEqual(heartbeat(session, 7, t0 + 31_000), []);
  await tick();
  assert.match(last("editMessageText")!.params.text, /Expired/);
});

test("nothing expires until an agent has declared its interval", async (t) => {
  const { session, calls } = fakeSession();
  t.after(() => session.stop());
  watched(session);
  session.dispatch(userSaid("early"));
  await tick();

  session.sweepInbox(Date.now() + 86_400_000);
  assert.equal(calls.filter((c) => c.method === "editMessageText").length, 0);
  assert.deepEqual(heartbeat(session, 7).map((m) => m.text), ["early"]);
});

test("an unprompted message from an unlisted user is dropped, not held", async (t) => {
  const { session, calls } = fakeSession();
  t.after(() => session.stop());
  watched(session, [42]);

  session.dispatch(userSaid("let me in", 99));
  await tick();

  assert.deepEqual(session.take(7), []);
  assert.equal(calls.length, 0);
});

test("a message sent before any agent checks in is refused, not held", async (t) => {
  const { session, last } = fakeSession();
  t.after(() => session.stop());
  let checkedIn = false;
  watched(session, undefined, () => checkedIn);

  session.dispatch(userSaid("anyone there?"));
  await tick();
  assert.deepEqual(session.take(7), []);
  assert.match(last("sendMessage")!.params.text, /Not accepted/);

  checkedIn = true;
  session.dispatch({ ...userSaid("now?"), update_id: 2, message: { message_id: 6, chat: { id: 7 }, from: { id: 42 }, text: "now?" } });
  await tick();
  assert.deepEqual(session.take(7).map((m) => m.text), ["now?"]);
});

test("tags Telegram does not know are translated or escaped, never left to break the message", async () => {
  const { session, calls } = fakeSession();
  await ask(session, 7, {
    project: "Lexi",
    message: "<b>Completed</b> — five fixed.<br/><br/>Build <code>20260917</code>.<div>note</div>",
    timeoutSeconds: 5,
  });

  const sent = calls[0].params;
  assert.equal(sent.parse_mode, "HTML", "a stray <br> must not cost the whole message its formatting");
  assert.match(sent.text, /five fixed\.\n\nBuild/, "<br/> becomes a line break");
  assert.doesNotMatch(sent.text, /<br|<div>/, "unsupported tags never reach Telegram");
  assert.match(sent.text, /<b>Completed<\/b>/, "supported tags are untouched");
  assert.match(sent.text, /\bnote$/, "layout tags go, their content stays");
  assert.match(toTelegramHtml("<marquee>hi</marquee>"), /&lt;marquee&gt;hi&lt;\/marquee&gt;/, "anything else is shown as text");
});

test("toTelegramHtml keeps links and collapses the gaps it opens", () => {
  assert.equal(toTelegramHtml("<p>one</p><p>two</p>"), "one\ntwo");
  assert.equal(toTelegramHtml('<a href="https://x.test">x</a>'), '<a href="https://x.test">x</a>');
  assert.equal(toTelegramHtml("<ul><li>a</li><li>b</li></ul>"), "• a\n• b");
});

test("a message Telegram still refuses arrives as readable text, not raw markup", async () => {
  const calls: { method: string; params: any }[] = [];
  let rejectedOnce = false;
  const session = new BotSession(async (method, params) => {
    if (method === "getUpdates") return await new Promise((r) => setTimeout(() => r([]), 10));
    calls.push({ method, params });
    if (method === "sendMessage" && params.parse_mode && !rejectedOnce) {
      rejectedOnce = true;
      throw new TelegramError("sendMessage", "Bad Request: can't parse entities: unclosed start tag");
    }
    return { message_id: 101 };
  }, 0);

  await ask(session, 7, { project: "P", message: "<b>unclosed and <i>tangled</b>", timeoutSeconds: 5 });

  const retry = calls[1].params;
  assert.equal(retry.parse_mode, undefined);
  assert.equal(retry.text.includes("<"), false, "the retry shows words, not tags");
  assert.match(retry.text, /unclosed and tangled/);
});

test("Markdown an agent writes out of habit is converted, not shown as punctuation", async () => {
  const { session, calls } = fakeSession();
  await ask(session, 7, {
    project: "Lexi",
    message: "**Completed** — see `src/app.ts` and [the PR](https://x.test).",
    timeoutSeconds: 5,
  });

  const sent = calls[0].params.text;
  assert.equal(calls[0].params.parse_mode, "HTML");
  assert.match(sent, /<b>Completed<\/b>/);
  assert.match(sent, /<code>src\/app\.ts<\/code>/);
  assert.match(sent, /<a href="https:\/\/x\.test">the PR<\/a>/);
  assert.doesNotMatch(sent, /\*\*|`/, "no markup punctuation survives");
});

test("Markdown conversion leaves code contents and globs alone", () => {
  const html = (s: string) => fromMarkdown(toTelegramHtml(s));
  assert.equal(html("`List<string>`"), "<code>List&lt;string&gt;</code>", "angle brackets inside code stay escaped");
  assert.equal(html("glob src/*.ts and **/*.js"), "glob src/*.ts and **/*.js", "single asterisks are not italics");
  assert.equal(html("```js\nconst a = 1;\n```"), "<pre><code>const a = 1;</code></pre>");
});
