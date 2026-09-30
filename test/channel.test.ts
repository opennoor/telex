import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

test("channel pushes idle and active messages and waits for explicit acknowledgement", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telex-channel-"));
  const config = join(dir, "config.json");
  const updates = join(dir, "updates.json");
  const inbox = join(dir, "inbox.json");
  const preload = join(dir, "telegram.mjs");
  writeFileSync(config, JSON.stringify({ bots: { main: { token: "123:test", chatId: 7, allowFrom: [42] } } }));
  writeFileSync(updates, "[]");
  writeFileSync(preload, `
    import { readFileSync } from "node:fs";
    globalThis.fetch = async (url, options) => {
      const method = String(url).split("/").at(-1);
      const input = JSON.parse(options.body);
      if (method === "getUpdates") await new Promise((done) => setTimeout(done, 10));
      const result = method === "getUpdates"
        ? (input.offset === -1 ? [] : JSON.parse(readFileSync(${JSON.stringify(updates)}, "utf8")).filter((u) => u.update_id >= input.offset))
        : { message_id: 101 };
      return { json: async () => ({ ok: true, result }) };
    };
  `);
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const client = new Client({ name: "telex-channel-test", version: "1" });
  const events: Array<{ content: string; meta: { delivery_id: string; message_id: string } }> = [];
  const channelNotification = z.object({
    method: z.literal("notifications/claude/channel"),
    params: z.object({ content: z.string(), meta: z.object({ delivery_id: z.string(), message_id: z.string() }) }),
  });
  client.setNotificationHandler(channelNotification, ({ params }) => { events.push(params); });
  t.after(async () => client.close());
  const launch = () => new StdioClientTransport({
    command: process.execPath, args: ["--import", preload, cli, "serve", "--channel"], cwd: dir,
    env: { ...process.env, TELEX_CONFIG: config, TELEX_PROJECT_CONFIG: join(dir, ".telex.json"),
      TELEX_STATE: join(dir, "sessions.json"), TELEX_INBOX: inbox },
  });
  await client.connect(launch());
  const event = async (id: number, text: string, ack = true) => {
    const start = Date.now();
    writeFileSync(updates, JSON.stringify([{ update_id: id, message: {
      message_id: id, chat: { id: 7 }, from: { id: 42 }, text,
    } }]));
    for (let i = 0; i < 100 && !events.some((item) => item.meta.message_id === String(id)); i++) {
      await new Promise((done) => setTimeout(done, 20));
    }
    const found = events.find((item) => item.meta.message_id === String(id));
    assert.ok(found, `message ${id} reached the channel`);
    assert.ok(Date.now() - start < 1000, "mock Telegram update reaches the channel in under a second");
    assert.equal(found.content, text);
    if (ack) {
      const result = await client.callTool({ name: "ack_channel_message", arguments: { delivery_id: found.meta.delivery_id } });
      assert.equal(JSON.parse((result.content as Array<{ text: string }>)[0].text).status, "delivered");
    }
    return found;
  };
  await new Promise((done) => setTimeout(done, 100));
  await event(1, "idle message");
  const pending = client.callTool({ name: "send_to_user", arguments: {
    project: "test", message: "Proceed?", options: ["Yes"], timeout_seconds: 5,
    project_path: dir, agent: "claude-code", interval_seconds: 60,
  } });
  await event(2, "active message");
  assert.equal(events.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(inbox, "utf8")).held, []);
  await pending;
  const unacked = await event(3, "reconnect message", false);
  await client.close();
  const resumed = new Client({ name: "telex-channel-test", version: "1" });
  const replayed: typeof events = [];
  resumed.setNotificationHandler(channelNotification, ({ params }) => { replayed.push(params); });
  t.after(async () => resumed.close());
  await resumed.connect(launch());
  for (let i = 0; i < 100 && replayed.length === 0; i++) await new Promise((done) => setTimeout(done, 20));
  assert.equal(replayed.length, 1, "unacknowledged event replays after reconnect");
  assert.equal(replayed[0].meta.delivery_id, unacked.meta.delivery_id);
  const ack = await resumed.callTool({ name: "ack_channel_message", arguments: { delivery_id: replayed[0].meta.delivery_id } });
  assert.equal(JSON.parse((ack.content as Array<{ text: string }>)[0].text).status, "delivered");
  assert.deepEqual(JSON.parse(readFileSync(inbox, "utf8")).held, []);
});
