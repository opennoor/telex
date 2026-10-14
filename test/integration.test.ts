import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { processStart } from "../src/wake.js";

const waitFor = async (predicate: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(label);
};
const value = (result: any) => JSON.parse(result.content[0].text);
const rootHook = (event: string, project_path: string, host_session_id = "same-host") => ({ event, host_session_id, project_path,
  agent: "codex", root_session: true, host_pid: process.pid, host_process_start: processStart(process.pid) });
function spoolRoot(dir: string, hostSessionId = "same-host") {
  const hostStart = processStart(process.pid);
  const path = join(dir, `hook-start-${createHash("sha256").update(`codex:${process.pid}`).digest("hex")}.json`);
  writeFileSync(path, JSON.stringify({ ...rootHook("SessionStart", dir, hostSessionId), hostPid: process.pid, hostStart, at: Date.now() }));
}
function sendRootHook(dir: string, input: object) {
  const socket = join(dir, readdirSync(dir).find((name) => /^hook-\d+-[0-9a-f-]+\.sock$/.test(name))!);
  return new Promise<any>((resolve, reject) => {
    const connection = createConnection(socket);
    let response = "";
    const event = (input as { event?: string }).event;
    const timer = setTimeout(() => { connection.destroy(); reject(new Error("host hook socket request timed out")); }, event === "SessionEnd" ? 20_000 : 3000);
    connection.on("connect", () => connection.end(`${JSON.stringify(input)}\n`));
    connection.on("data", (chunk) => { response += chunk; if (response.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(response.slice(0, response.indexOf("\n")))); connection.destroy(); } });
    connection.on("error", reject);
    connection.on("close", () => { if (!response.includes("\n")) reject(new Error("host hook socket closed without a response")); });
  });
}

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
  assert.match(outboundA.input.text, /↳ worktree telex-integration-/);
  assert.match(outboundA.input.text, /Full payload for agent-alpha/);

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
  spoolRoot(dir);
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
  const callHook = (client: Client, event = "SessionStart", hostSessionId = "same-host") => client.callTool({ name: "host_hook", arguments: {
    event, host_session_id: hostSessionId, project_path: dir, agent: "codex",
  } });
  const calls = (): any[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const hash = createHash("sha256").update("123:test").digest("hex");
  const first = await connect();
  await waitFor(() => calls().some((call) => call.input.text?.includes("session started")), "startup announced before a model tool call");
  const firstHook = value(await callHook(first));
  assert.match(firstHook.hookSpecificOutput.additionalContext, /choice buttons/);
  await first.close();
  assert.equal(calls().filter((call) => call.input.text?.includes("session ended")).length, 0,
    "an MCP reconnect does not end the still-live host root");
  const second = await connect();
  await waitFor(() => calls().filter((call) => call.input.text?.includes("session started")).length === 1, "same root session was not announced twice after MCP reconnect");
  const provisionalResult = value(await second.callTool({ name: "heartbeat", arguments: { project_path: dir, agent: "codex", interval_seconds: 60 } }));
  const startupMessage = calls().filter((call) => call.input.text?.includes("session started")).at(-1).result.message_id;
  const startRoute = JSON.parse(readFileSync(join(dir, "routes", `${hash}.json`), "utf8"));
  assert.equal(startRoute.messages[`7:${startupMessage}`], `${provisionalResult.session_id}:7`,
    "a lifecycle start reply maps to the active route even though host and MCP PIDs differ");
  writeFileSync(updates, JSON.stringify([{ update_id: 1, message: { message_id: 501, chat: { id: 7 }, from: { id: 42 },
    text: "before host identification", reply_to_message: { message_id: startupMessage } } }]));
  await waitFor(() => { try { return JSON.parse(readFileSync(inbox, "utf8")).held.some((m: any) => m.message_id === 501); } catch { return false; } }, "startup reply queued");
  const held = JSON.parse(readFileSync(inbox, "utf8"));
  const originalKey = held.held[0].key;
  held.held.push({ key: originalKey, message_id: 502, text: "claimed before identity", received_at: Date.now(), expires_at: Date.now() + 60000, wake_claim: "channel:preserved", receipt_id: 333 });
  writeFileSync(inbox, JSON.stringify(held));
  assert.match(value(await callHook(second)).hookSpecificOutput.additionalContext, /before host identification/);
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
  assert.equal(calls().filter((call) => call.input.text?.includes("session ended")).length, 0, "Stop does not end the root lifetime");
  await callHook(second, "SessionStart", "untrusted-child-host");
  await callHook(second, "SessionEnd");
  assert.equal(calls().filter((call) => call.input.text?.includes("session ended")).length, 0, "a model-call cannot spoof root SessionEnd");
  await sendRootHook(dir, rootHook("SessionEnd", dir));
  assert.equal(calls().filter((call) => call.input.text?.includes("session ended")).length, 1);
});

test("simultaneous attested root sessions keep independent lifecycle and reply routes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telex-multi-root-"));
  const config = join(dir, "config.json"), log = join(dir, "api.jsonl"), preload = join(dir, "telegram.mjs");
  writeFileSync(config, JSON.stringify({ bots: { main: { token: "123:test", chatId: 7 } } }));
  writeFileSync(join(dir, ".telex.json"), JSON.stringify({ bot: "main" }));
  writeFileSync(log, "");
  writeFileSync(preload, `import {appendFileSync} from 'node:fs';let n=0;
    globalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1),input=JSON.parse(options.body);
      if(method==='getUpdates'){await new Promise(resolve=>setTimeout(resolve,15));return {json:async()=>({ok:true,result:[]})};}
      appendFileSync(${JSON.stringify(log)},JSON.stringify({method,input})+'\\n');
      return {json:async()=>({ok:true,result:{message_id:++n}})};};`);
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, TELEX_CONFIG: config, TELEX_PROJECT_CONFIG: join(dir, ".telex.json"), TELEX_STATE: join(dir, "sessions.json") };
  const client = new Client({ name: "multi-root", version: "1" });
  t.after(async () => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, cli, "serve"], cwd: dir, env }));
  await waitFor(() => readdirSync(dir).some((name) => /^hook-\d+-[0-9a-f-]+\.sock$/.test(name)), "private hook socket starts");
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls().filter((call) => call.input.text?.includes("session started")).length, 0, "generic MCP starts silently");
  const firstStart = await sendRootHook(dir, rootHook("SessionStart", dir, "root-one"));
  assert.equal(firstStart.accepted, true, "first root hook reaches the local server");
  await waitFor(() => calls().filter((call) => call.input.text?.includes("session started")).length === 1, "first root starts once");
  await sendRootHook(dir, rootHook("SessionStart", dir, "root-two"));
  await waitFor(() => calls().filter((call) => call.input.text?.includes("session started")).length === 2, "second root starts once");
  const hash = createHash("sha256").update("123:test").digest("hex");
  const routeState = () => JSON.parse(readFileSync(join(dir, "routes", `${hash}.json`), "utf8"));
  const starts = calls().filter((call) => call.input.text?.includes("session started"));
  const rootOne = routeState().messages["7:1"];
  const rootTwo = routeState().messages["7:2"];
  assert.notEqual(rootOne, rootTwo, "each root start message maps to its own route");
  await sendRootHook(dir, rootHook("SessionEnd", dir, "root-one"));
  await waitFor(() => calls().filter((call) => call.input.text?.includes("session ended")).length === 1, "first root ends once");
  assert.deepEqual(Object.keys(routeState().routes), [rootTwo], "ending one root leaves the other root route active");
  await sendRootHook(dir, rootHook("SessionEnd", dir, "root-one"));
  assert.equal(calls().filter((call) => call.input.text?.includes("session ended")).length, 1, "duplicate old end is ignored");
  await sendRootHook(dir, rootHook("SessionEnd", dir, "root-two"));
  await waitFor(() => calls().filter((call) => call.input.text?.includes("session ended")).length === 2, "second root ends once");
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
  spoolRoot(dir);
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
  const pendingEnd = sendRootHook(dir, rootHook("SessionEnd", dir));
  void pendingEnd.catch(() => {});
  await waitFor(() => existsSync(ending), "old lifetime end is paused in Telegram I/O");
  const second = await connect();
  await second.callTool({ name: "heartbeat", arguments: { project_path: dir, agent: "codex", interval_seconds: 60 } });
  const hash = createHash("sha256").update("123:test").digest("hex");
  const routes = () => Object.values(JSON.parse(readFileSync(join(dir, "routes", `${hash}.json`), "utf8")).routes) as any[];
  await waitFor(() => routes().length === 1, "new connection owns the stable destination");
  const owner = routes()[0].pid;
  writeFileSync(release, "release");
  await waitFor(() => {
    try {
      const file = readdirSync(join(dir, "lifecycle")).find((name) => name.endsWith(".json"));
      return Boolean(file && JSON.parse(readFileSync(join(dir, "lifecycle", file), "utf8")).end === "sent");
    } catch { return false; }
  }, "old root end notification completes");
  void pendingEnd;
  assert.equal(routes()[0]?.pid, owner, "old cleanup cannot delete the new process's route");
});
