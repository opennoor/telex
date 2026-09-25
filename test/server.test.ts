import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("plugin hook checks in and delivers a polled Telegram message", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telex-server-"));
  const config = join(dir, "config.json");
  const inbox = join(dir, "inbox.json");
  const updates = join(dir, "updates.json");
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, cli, "serve"],
    env: { ...process.env, TELEX_CONFIG: config, TELEX_BOT: "main", TELEX_PROJECT_CONFIG: join(dir, ".telex.json"),
      TELEX_STATE: join(dir, "sessions.json"), TELEX_INBOX: inbox },
  });
  const client = new Client({ name: "telex-test", version: "1" });
  t.after(async () => client.close());
  await client.connect(transport);
  const call = async (event: string) => {
    const result = await client.callTool({ name: "host_hook", arguments: {
      event, host_session_id: "thr_test", project_path: dir, agent: "codex",
    } });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };

  assert.deepEqual(await call("UserPromptSubmit"), {});
  writeFileSync(updates, JSON.stringify([{ update_id: 1, message: {
    message_id: 9, chat: { id: 7 }, from: { id: 42 }, text: "pause deployment",
  } }]));
  for (let i = 0; i < 100; i++) {
    try {
      if (JSON.parse(readFileSync(inbox, "utf8")).held[0]?.receipt_id) break;
    } catch { /* poll until the server queues and receipts the message */ }
    await new Promise((done) => setTimeout(done, 20));
  }
  const result = await call("PostToolUse");
  assert.match(result.hookSpecificOutput.additionalContext, /pause deployment/);
  assert.deepEqual(await call("PostToolUse"), {}, "the message is delivered once");
});

test("a waiting question takes over polling when the owner exits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telex-takeover-"));
  const config = join(dir, "config.json");
  const updates = join(dir, "updates.json");
  const question = join(dir, "question.txt");
  const preload = join(dir, "telegram.mjs");
  writeFileSync(config, JSON.stringify({ bots: { main: { token: "123:test", chatId: 7, allowFrom: [42] } } }));
  writeFileSync(updates, "[]");
  writeFileSync(preload, `
    import { readFileSync, writeFileSync } from "node:fs";
    globalThis.fetch = async (url, options) => {
      const method = String(url).split("/").at(-1);
      const input = JSON.parse(options.body);
      if (method === "getUpdates") await new Promise((done) => setTimeout(done, 10));
      if (method === "sendMessage" && input.reply_markup?.inline_keyboard) {
        writeFileSync(${JSON.stringify(question)}, input.reply_markup.inline_keyboard[0][0].callback_data);
      }
      const result = method === "getUpdates"
        ? (input.offset === -1 ? [] : JSON.parse(readFileSync(${JSON.stringify(updates)}, "utf8")).filter((u) => u.update_id >= input.offset))
        : { message_id: 101 };
      return { json: async () => ({ ok: true, result }) };
    };
  `);
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, TELEX_CONFIG: config, TELEX_BOT: "main", TELEX_PROJECT_CONFIG: join(dir, ".telex.json"),
    TELEX_STATE: join(dir, "sessions.json"), TELEX_INBOX: join(dir, "inbox.json") };
  const connect = async () => {
    const client = new Client({ name: "telex-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, cli, "serve"], env }));
    return client;
  };
  const owner = await connect();
  const asker = await connect();
  t.after(async () => { await owner.close(); await asker.close(); });
  const hook = { event: "UserPromptSubmit", host_session_id: "thr_test", project_path: dir, agent: "codex" };
  await owner.callTool({ name: "host_hook", arguments: hook });
  await asker.callTool({ name: "host_hook", arguments: hook });
  const pending = asker.callTool({ name: "send_to_user", arguments: {
    project: "test", message: "Continue?", options: ["Yes"], timeout_seconds: 5,
    project_path: dir, agent: "codex", interval_seconds: 60,
  } });
  let data = "";
  for (let i = 0; i < 100; i++) {
    try { data = readFileSync(question, "utf8"); } catch { /* wait for sendMessage */ }
    if (data) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(data, "the nonowner asked its question");
  await owner.close();
  await new Promise((done) => setTimeout(done, 1200));
  writeFileSync(updates, JSON.stringify([{ update_id: 1, callback_query: {
    id: "cb1", data, from: { id: 42 }, message: { message_id: 101, chat: { id: 7 } },
  } }]));
  const result = await pending;
  assert.equal(JSON.parse((result.content as Array<{ text: string }>)[0].text).response, "Yes");
});
