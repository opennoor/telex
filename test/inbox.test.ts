import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileInbox, memoryInbox, scopedInbox, inboxPath } from "../src/inbox.ts";
import type { Incoming } from "../src/telegram.ts";

function isolated() {
  process.env.TELEX_INBOX = join(mkdtempSync(join(tmpdir(), "telex-inbox-")), "inbox.json");
  return inboxPath();
}

const said = (text: string, id = 1): Incoming => ({ message_id: id, text, received_at: Date.now() });

test("a message queued by one process is collected by another", () => {
  isolated();
  // Two telex processes, two store objects, one queue: the polling agent queues and the
  // heartbeating agent collects. Holding it in memory is what left it sitting at "held".
  const poller = fileInbox();
  const heartbeating = fileInbox();

  poller.push("7", said("stop the dpj run"));

  assert.deepEqual(heartbeating.take("7").map((m) => m.text), ["stop the dpj run"]);
  assert.deepEqual(poller.take("7"), [], "collected once, by whoever asked first");
});

test("a queue is per chat", () => {
  isolated();
  const store = fileInbox();
  store.push("7", said("for seven"));
  store.push("9", said("for nine", 2));

  assert.deepEqual(store.take("9").map((m) => m.text), ["for nine"]);
  assert.deepEqual(store.take("7").map((m) => m.text), ["for seven"]);
});

test("two bots in one chat keep separate messages and receipts", () => {
  isolated();
  const shared = fileInbox();
  const first = scopedInbox(shared, "token-a");
  const second = scopedInbox(shared, "token-b");
  first.push("7", said("for first"));
  second.push("7", said("for second", 2));
  first.receipt("7", 1, 555);
  assert.deepEqual(second.take("7").map((m) => m.text), ["for second"]);
  assert.deepEqual(first.take("7").map((m) => [m.text, m.receipt_id]), [["for first", 555]]);
});

test("nothing expires until a deadline was set for it", () => {
  isolated();
  const store = fileInbox();
  store.push("7", said("no interval declared"));

  assert.deepEqual(store.expire("7", Date.now() + 86_400_000), [], "no deadline, no expiry");
  assert.equal(store.take("7").length, 1, "and it is still there to collect");
});

test("a deadline set by one process is honoured by another", () => {
  isolated();
  const now = Date.now();
  fileInbox().push("7", said("too late"), now + 30_000);

  const other = fileInbox();
  assert.deepEqual(other.expire("7", now + 20_000), [], "still inside the window");
  assert.deepEqual(other.expire("7", now + 31_000).map((m) => m.text), ["too late"]);
  assert.deepEqual(other.take("7"), [], "an expired message is gone, not delivered late");
});

test("a receipt recorded by the poller is visible to whoever settles it", () => {
  isolated();
  fileInbox().push("7", said("held"));

  fileInbox().receipt("7", 1, 555);

  assert.equal(fileInbox().take("7")[0].receipt_id, 555);
});

test("re-queueing the same message does not duplicate it", () => {
  isolated();
  const store = fileInbox();
  store.push("7", said("once"));
  store.push("7", said("once"));

  assert.equal(store.take("7").length, 1);
});

test("the memory queue hands back the object it was given, receipt id and all", () => {
  const store = memoryInbox();
  const message = said("held");
  store.push("7", message);
  message.receipt_id = 99; // stamped after Telegram answers, as ask.ts does

  assert.equal(store.take("7")[0].receipt_id, 99);
});
