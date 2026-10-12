import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const waitFor = async (predicate: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(label);
};
const value = (result: any) => JSON.parse(result.content[0].text);

test("multiple MCP sessions share a durable listener without sharing replies, buttons or queues", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telex-integration-"));
  const config = join(dir, "config.json");
  const updates = join(dir, "updates.json");
  const log = join(dir, "api.jsonl");
  const inbox = join(dir, "inbox.json");
  const overlap = join(dir, "overlap");
  const preload = join(dir, "telegram.mjs");
  writeFileSync(config, JSON.stringify({ bots: { main: { token: "123:test", chatId: 7, allowFrom: [42] } } }));
  writeFileSync(updates, "[]");
  writeFileSync(log, "");
  writeFileSync(preload, `
    import { readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync } from "node:fs";
    let sequence = 0;
    globalThis.fetch = async (url, options) => {
      const method = String(url).split("/").at(-1);
      const input = JSON.parse(options.body);
      let result;
      if (method === "getUpdates") {
        const lock = ${JSON.stringify(join(dir, "poll.lock"))};
        try { closeSync(openSync(lock, "wx")); }
        catch {
          let alive = false;
          try { process.kill(Number(readFileSync(lock, "utf8")), 0); alive = true; } catch {}
          if (alive) writeFileSync(${JSON.stringify(overlap)}, "overlapping Telegram polls");
        }
        writeFileSync(lock, String(process.pid));
        try {
          await new Promise((resolve) => setTimeout(resolve, 15));
          result = input.offset === -1 ? [] : JSON.parse(readFileSync(${JSON.stringify(updates)}, "utf8")).filter((u) => u.update_id >= input.offset);
        } finally {
          try { if (Number(readFileSync(lock, "utf8")) === process.pid) unlinkSync(lock); } catch {}
        }
      } else {
        result = { message_id: process.pid * 1000 + ++sequence };
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, input, result }) + "\\n");
      }
      return { json: async () => ({ ok: true, result }) };
    };
  `);
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, TELEX_CONFIG: config, TELEX_PROJECT_CONFIG: join(dir, ".telex.json"),
    TELEX_STATE: join(dir, "sessions.json"), TELEX_INBOX: inbox };
  const daemons: ChildProcess[] = [];
  const launchDaemon = async () => {
    const child = spawn(process.execPath, ["--import", preload, cli, "daemon"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    daemons.push(child);
    let errors = "";
    child.stderr!.on("data", (chunk) => { errors += chunk; });
    await waitFor(() => errors.includes("listener running"), "daemon started");
    return child;
  };
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const daemon of daemons) if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
  });
  let daemon = await launchDaemon();
  const connect = async (identity: string) => {
    const client = new Client({ name: identity, version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--import", preload, cli, "serve"], cwd: dir, env: { ...env, TELEX_SESSION_ID: identity } }));
    return client;
  };
  const [a, b] = await Promise.all([connect("alpha"), connect("beta")]);
  const args = (agent: string) => ({ project_path: dir, agent, interval_seconds: 60 });
  const notify = async (client: Client, agent: string) => value(await client.callTool({ name: "send_to_user", arguments: {
    ...args(agent), project: "default bot", message: `Full payload for ${agent}`,
  } }));
  const [sentA, sentB] = await Promise.all([notify(a, "agent-alpha"), notify(b, "agent-beta")]);
  const calls = (): any[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const outboundA = calls().find((call) => call.result.message_id === sentA.message_id);
  assert.match(outboundA.input.text, /main · agent-alpha/);
  assert.match(outboundA.input.text, /Full payload for agent-alpha/);
  assert.ok(outboundA.input.text.includes(dir));

  const questions = [a, b].map((client, i) => client.callTool({ name: "send_to_user", arguments: {
    ...args(i ? "agent-beta" : "agent-alpha"), project: "choice", message: i ? "Choose beta" : "Choose alpha",
    options: [i ? "Beta answer" : "Alpha answer"], timeout_seconds: 10,
  } }));
  await waitFor(() => calls().filter((call) => call.input.text?.includes("Choose ") && call.input.reply_markup?.inline_keyboard).length === 2,
    "both independent keyboards sent");
  const keys = calls().filter((call) => call.input.text?.includes("Choose ") && call.input.reply_markup?.inline_keyboard);
  writeFileSync(updates, JSON.stringify(keys.map((call, i) => ({ update_id: i + 1, callback_query: {
    id: `answer-${i}`, from: { id: 42 }, data: call.input.reply_markup.inline_keyboard[0][0].callback_data,
    message: { message_id: call.result.message_id, chat: { id: 7 } },
  } }))));
  assert.deepEqual((await Promise.all(questions)).map((result) => value(result).response), ["Alpha answer", "Beta answer"]);
  const update = (id: number, messageId: number, text: string) => writeFileSync(updates, JSON.stringify([{ update_id: id, message: {
    message_id: id + 100, chat: { id: 7 }, from: { id: 42 }, text, reply_to_message: { message_id: messageId },
  } }]));
  const held = (text: string) => {
    try { return JSON.parse(readFileSync(inbox, "utf8")).held.some((entry: any) => entry.text === text && entry.receipt_id); }
    catch { return false; }
  };
  const beat = async (client: Client, agent: string) => value(await client.callTool({ name: "heartbeat", arguments: args(agent) })).messages;
  update(3, sentA.message_id, "only alpha");
  await waitFor(() => held("only alpha"), "exact reply queued");
  assert.deepEqual(await beat(b, "agent-beta"), []);
  assert.equal((await beat(a, "agent-alpha"))[0].text, "only alpha");

  const exited = once(daemon, "exit");
  daemon.kill();
  await exited;
  daemon = await launchDaemon();
  update(4, sentB.message_id, "beta after listener restart");
  await waitFor(() => held("beta after listener restart"), "restart retained outgoing reply destination and cursor");
  assert.deepEqual(await beat(a, "agent-alpha"), []);
  assert.equal((await beat(b, "agent-beta"))[0].text, "beta after listener restart");
  assert.equal(calls().filter((call) => call.input.reply_parameters?.message_id === 103).length, 1,
    "listener restart did not receipt the previously delivered update again");
  assert.equal(existsSync(overlap), false, "central and fallback processes never overlap getUpdates");
});

test("host reconnect consolidates the announced connection and preserves earlier reply mappings and claims", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telex-host-reattach-"));
  const config = join(dir, "config.json");
  const state = join(dir, "sessions.json");
  const inbox = join(dir, "inbox.json");
  const updates = join(dir, "updates.json");
  const log = join(dir, "api.jsonl");
  const preload = join(dir, "telegram.mjs");
  writeFileSync(config, JSON.stringify({ bots: { main: { token: "123:test", chatId: 7, allowFrom: [42] } } }));
  writeFileSync(join(dir, ".telex.json"), JSON.stringify({ bot: "main" }));
  writeFileSync(updates, "[]"); writeFileSync(log, "");
  writeFileSync(preload, `import {readFileSync,appendFileSync} from 'node:fs'; let n=0;
    globalThis.fetch=async(url,opts)=>{const method=String(url).split('/').at(-1),input=JSON.parse(opts.body);
      if(method==='getUpdates') await new Promise(r=>setTimeout(r,10));
      const result=method==='getUpdates'?(input.offset===-1?[]:JSON.parse(readFileSync(${JSON.stringify(updates)},'utf8')).filter(u=>u.update_id>=input.offset)):{message_id:process.pid*1000+(++n)};
      if(method!=='getUpdates') appendFileSync(${JSON.stringify(log)},JSON.stringify({method,input,result})+'\\n');
      return {json:async()=>({ok:true,result})};};`);
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, TELEX_CONFIG: config, TELEX_PROJECT_CONFIG: join(dir, ".telex.json"), TELEX_STATE: state, TELEX_INBOX: inbox };
  delete (env as NodeJS.ProcessEnv).TELEX_SESSION_ID;
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ name: "host-reattach", version: "1" }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, cli, "serve"], cwd: dir, env }));
    return client;
  };
  t.after(async () => { for (const client of clients) await client.close(); });
  const callHook = (client: Client, event = "SessionStart") => client.callTool({ name: "host_hook", arguments: {
    event, host_session_id: "same-host", project_path: dir, agent: "codex",
  } });
  const calls = (): any[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const first = await connect();
  await waitFor(() => calls().some((call) => call.input.text?.includes("session started")), "startup announced before a model tool call");
  const firstHook = value(await callHook(first));
  assert.match(firstHook.hookSpecificOutput.additionalContext, /choice buttons/);
  await first.close();
  const second = await connect();
  await waitFor(() => calls().filter((call) => call.input.text?.includes("session started")).length === 2, "reconnected MCP announced");
  const provisionalResult = value(await second.callTool({ name: "heartbeat", arguments: { project_path: dir, agent: "codex", interval_seconds: 60 } }));
  const startupMessage = calls().filter((call) => call.input.text?.includes("session started")).at(-1).result.message_id;
  writeFileSync(updates, JSON.stringify([{ update_id: 1, message: { message_id: 501, chat: { id: 7 }, from: { id: 42 },
    text: "before host identification", reply_to_message: { message_id: startupMessage } } }]));
  await waitFor(() => { try { return JSON.parse(readFileSync(inbox, "utf8")).held.some((m: any) => m.message_id === 501); } catch { return false; } }, "startup reply queued");
  const held = JSON.parse(readFileSync(inbox, "utf8"));
  const originalKey = held.held[0].key;
  held.held.push({ key: originalKey, message_id: 502, text: "claimed before identity", received_at: Date.now(), expires_at: Date.now() + 60000, wake_claim: "channel:preserved", receipt_id: 333 });
  writeFileSync(inbox, JSON.stringify(held));
  assert.match(value(await callHook(second)).hookSpecificOutput.additionalContext, /before host identification/);
  const hash = (await import("node:crypto")).createHash("sha256").update("123:test").digest("hex");
  const routeState = JSON.parse(readFileSync(join(dir, "routes", `${hash}.json`), "utf8"));
  const routes = Object.values(routeState.routes) as any[];
  assert.equal(routes.length, 1, "provisional route is consolidated into the same host destination");
  const remaining = JSON.parse(readFileSync(inbox, "utf8")).held;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].wake_claim, "channel:preserved");
  assert.equal(remaining[0].receipt_id, 333);
  assert.equal(remaining[0].key, `${hash}:${routes[0].id}:7`);
  writeFileSync(updates, JSON.stringify([{ update_id: 2, message: { message_id: 503, chat: { id: 7 }, from: { id: 42 },
    text: "after host identification", reply_to_message: { message_id: startupMessage } } }]));
  await waitFor(() => JSON.parse(readFileSync(inbox, "utf8")).held.some((m: any) => m.message_id === 503), "original startup reply mapping survives consolidation");
  const result = value(await second.callTool({ name: "heartbeat", arguments: { project_path: dir, agent: "codex", interval_seconds: 60, session_id: provisionalResult.session_id } }));
  assert.equal(result.messages[0].text, "after host identification");
  assert.equal(`${result.session_id}:7`, routes[0].id, "echoing a provisional id returns the canonical session");
  await callHook(second, "Stop");
  assert.equal(calls().filter((call) => call.input.text?.includes("session ended")).length, 1, "Stop does not end the second lifetime");
  await callHook(second, "SessionEnd");
  assert.equal(calls().filter((call) => call.input.text?.includes("session ended")).length, 2);
});

test("delayed old SessionEnd cleanup cannot remove a newly reattached owner", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telex-end-owner-"));
  const state = join(dir, "sessions.json");
  const config = join(dir, "config.json");
  const ending = join(dir, "ending");
  const release = join(dir, "release");
  const preload = join(dir, "telegram.mjs");
  writeFileSync(config, JSON.stringify({ bots: { main: { token: "123:test", chatId: 7 } } }));
  writeFileSync(join(dir, ".telex.json"), JSON.stringify({ bot: "main" }));
  writeFileSync(preload, `import {existsSync,writeFileSync} from 'node:fs'; let n=0;
    globalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1),input=JSON.parse(options.body);
      if(method==='getUpdates') await new Promise(r=>setTimeout(r,10));
      if(method==='sendMessage' && input.text.includes('session ended')) {
        writeFileSync(${JSON.stringify(ending)},'waiting');
        while(!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10));
      }
      return {json:async()=>({ok:true,result:method==='getUpdates'?[]:{message_id:++n}})};};`);
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, TELEX_CONFIG: config, TELEX_STATE: state, TELEX_PROJECT_CONFIG: join(dir, ".telex.json"), TELEX_SESSION_ID: "same-conversation" };
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ name: "owner-race", version: "1" }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, cli, "serve"], cwd: dir, env }));
    return client;
  };
  t.after(async () => { writeFileSync(release, "release"); for (const client of clients) await client.close(); });
  const first = await connect();
  const hook = { host_session_id: "same-host", project_path: dir, agent: "codex" };
  await first.callTool({ name: "host_hook", arguments: { ...hook, event: "SessionStart" } });
  const pendingEnd = first.callTool({ name: "host_hook", arguments: { ...hook, event: "SessionEnd" } });
  await waitFor(() => existsSync(ending), "old lifetime end is paused in Telegram I/O");
  await connect();
  const hash = (await import("node:crypto")).createHash("sha256").update("123:test").digest("hex");
  const routes = () => Object.values(JSON.parse(readFileSync(join(dir, "routes", `${hash}.json`), "utf8")).routes) as any[];
  await waitFor(() => routes().length === 1, "new connection owns the stable destination");
  const owner = routes()[0].pid;
  writeFileSync(release, "release");
  await pendingEnd;
  assert.equal(routes()[0]?.pid, owner, "old cleanup cannot delete the new process's route");
});
