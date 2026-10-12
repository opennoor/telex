import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { processAncestors } from "../src/host.ts";

const root = join(process.cwd(), "plugins/telex");

function invokeCodexHook(input: object, state: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [join(root, "hooks/codex.mjs")], {
      env: { ...process.env, TELEX_STATE: state },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("both host marketplaces install the bundled telex plugin", () => {
  const marketplaceRoot = join(process.cwd(), "plugins");
  for (const file of [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]) {
    const marketplace = JSON.parse(readFileSync(join(marketplaceRoot, file), "utf8"));
    assert.equal(marketplace.name, "telex");
    assert.deepEqual(marketplace.plugins.map((plugin: { name: string }) => plugin.name), ["telex"]);
    const source = marketplace.plugins[0].source;
    const relative = typeof source === "string" ? source : source.path;
    assert.equal(relative, "./telex");
    assert.ok(existsSync(join(marketplaceRoot, relative, ".mcp.json")));
  }
});

test("Codex command hook stays silent without Telex and resumes over its local socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telex-hook-"));
  const state = join(dir, "sessions.json");
  const socketPath = join(dir, `hook-${process.pid}-${randomUUID()}.sock`);
  const input = { hook_event_name: "UserPromptSubmit", session_id: "codex-session", cwd: "/project",
    prompt: "hello" };
  const invoke = () => invokeCodexHook(input, state);
  try {
    assert.deepEqual(await invoke(), { code: 0, stdout: "", stderr: "" });
    let received: unknown;
    const server = createServer((socket) => {
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk;
        if (!request.includes("\n")) return;
        const value = JSON.parse(request.slice(0, request.indexOf("\n")));
        if (value.probe) { socket.end(`${JSON.stringify({ eligible: true, bound: true, ancestors: processAncestors(process.pid) })}\n`); return; }
        received = value;
        socket.end(`${JSON.stringify({ accepted: true, output: {
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Telegram message" },
        } })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      assert.deepEqual(await invoke(), {
        code: 0,
        stdout: `${JSON.stringify({ hookSpecificOutput: {
          hookEventName: "UserPromptSubmit", additionalContext: "Telegram message",
        } })}\n`,
        stderr: "",
      });
      assert.deepEqual(received, { event: "UserPromptSubmit", host_session_id: "codex-session",
        project_path: "/project", agent: "codex", prompt: "hello" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex command hook delivers a Telegram update through the running Telex server once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "telex-codex-hook-"));
  const config = join(dir, "config.json");
  const updates = join(dir, "updates.json");
  const inbox = join(dir, "inbox.json");
  const state = join(dir, "sessions.json");
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
  const input = { hook_event_name: "PostToolUse", session_id: "thr_test", cwd: dir };
  const absentAt = performance.now();
  assert.deepEqual(await invokeCodexHook(input, state), { code: 0, stdout: "", stderr: "" });
  t.diagnostic(`absent Telex hook: ${Math.round(performance.now() - absentAt)} ms`);

  const client = new Client({ name: "telex-test", version: "1" });
  t.after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, fileURLToPath(new URL("../../dist/cli.js", import.meta.url)), "serve"],
    cwd: dir,
    env: { ...process.env, TELEX_CONFIG: config, TELEX_BOT: "main",
      TELEX_PROJECT_CONFIG: join(dir, ".telex.json"), TELEX_STATE: state, TELEX_INBOX: inbox },
  }));
  assert.deepEqual(await invokeCodexHook(input, state), { code: 0, stdout: "{}\n", stderr: "" });
  writeFileSync(updates, JSON.stringify([{ update_id: 1, message: {
    message_id: 9, chat: { id: 7 }, from: { id: 42 }, text: "pause deployment",
  } }]));
  let queued = false;
  for (let i = 0; i < 100; i++) {
    try { queued = Boolean(JSON.parse(readFileSync(inbox, "utf8")).held[0]?.receipt_id); } catch { /* still polling */ }
    if (queued) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(queued, "Telex queued and receipted the update");
  const availableAt = performance.now();
  const delivered = await invokeCodexHook(input, state);
  t.diagnostic(`available Telex hook: ${Math.round(performance.now() - availableAt)} ms`);
  assert.equal(delivered.code, 0);
  assert.equal(delivered.stderr, "");
  assert.match(JSON.parse(delivered.stdout).hookSpecificOutput.additionalContext, /pause deployment/);
  assert.deepEqual(await invokeCodexHook(input, state), { code: 0, stdout: "{}\n", stderr: "" });
});

test("host plugins register one MCP server and one explicit hook file", () => {
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  const packageVersion = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;
  assert.deepEqual(Object.keys(mcp.mcpServers), ["telex"]);
  assert.equal(existsSync(join(root, "hooks/hooks.json")), false);

  for (const [host, server, agent, manifestPath] of [
    ["codex", "telex", "codex", ".codex-plugin/plugin.json"],
    ["claude", "plugin:telex:telex", "claude-code", ".claude-plugin/plugin.json"],
  ]) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    assert.equal(manifest.version, packageVersion, `${host} plugin must refresh with the npm release`);
    const hookPath = `./hooks/${host}.json`;
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.equal(manifest.hooks, hookPath);

    const config = JSON.parse(readFileSync(join(root, hookPath), "utf8"));
    assert.deepEqual(Object.keys(config.hooks).sort(), ["PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    for (const event of Object.keys(config.hooks)) {
      const [group] = config.hooks[event];
      assert.equal(group.hooks.length, 1);
      assert.deepEqual(group.hooks[0], host === "codex" || event === "SessionStart" || event === "SessionEnd" ? {
        type: "command",
        command: host === "claude" ? 'node "${CLAUDE_PLUGIN_ROOT}/hooks/codex.mjs" claude-code' : 'node "${PLUGIN_ROOT}/hooks/codex.mjs"',
        timeout: event === "SessionEnd" ? 1.5 : 3,
      } : {
        type: "mcp_tool",
        server,
        tool: "host_hook",
        input: {
          event,
          host_session_id: "${session_id}",
          project_path: "${cwd}",
          agent,
          ...(event === "Stop" ? { stop_hook_active: "${stop_hook_active}" } : {}),
        },
      });
    }
  }
});

test("same-worktree command hooks never guess between equally eligible conversations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telex-hook-ambiguous-"));
  const servers = [];
  let deliveries = 0;
  for (let i = 0; i < 2; i++) {
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        const input = JSON.parse(chunk.toString().trim());
        if (!input.probe) deliveries++;
        socket.end(`${JSON.stringify(input.probe ? { eligible: true, bound: false, ancestors: processAncestors(process.pid) } : { accepted: true })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(join(dir, `hook-${process.pid}-${randomUUID()}.sock`), resolve));
    servers.push(server);
  }
  try {
    const result = await invokeCodexHook({ hook_event_name: "PostToolUse", session_id: "new-thread", cwd: dir }, join(dir, "sessions.json"));
    assert.equal(result.stdout, "");
    assert.equal(deliveries, 0);
  } finally { for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("SessionStart before MCP readiness is spooled for its exact live host and SessionEnd closes once", async (t) => {
  if (process.platform !== "linux") { t.skip("exact process-start spool verification uses Linux /proc"); return; }
  const originalTitle = process.title;
  process.title = "codex";
  const dir = mkdtempSync(join(tmpdir(), "telex-start-spool-"));
  const state = join(dir, "sessions.json");
  const config = join(dir, "config.json");
  const log = join(dir, "calls.jsonl");
  const preload = join(dir, "telegram.mjs");
  writeFileSync(config, JSON.stringify({ bots: { main: { token: "123:test", chatId: 7 } } }));
  writeFileSync(join(dir, ".telex.json"), JSON.stringify({ bot: "main" }));
  writeFileSync(log, "");
  writeFileSync(preload, `import {appendFileSync} from 'node:fs'; let n=0;
    globalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1),input=JSON.parse(options.body);
      if(method==='getUpdates') await new Promise(r=>setTimeout(r,10));
      else { if(input.text?.includes('session ended')) await new Promise(r=>setTimeout(r,1200));
        appendFileSync(${JSON.stringify(log)},JSON.stringify(input)+'\\n'); }
      return {json:async()=>({ok:true,result:method==='getUpdates'?[]:{message_id:++n}})};};`);
  const input = { hook_event_name: "SessionStart", session_id: "spooled-host", cwd: dir };
  const client = new Client({ name: "spool-test", version: "1" });
  try {
    const start = await invokeCodexHook(input, state);
    assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /choice buttons/);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--import", preload, fileURLToPath(new URL("../../dist/cli.js", import.meta.url)), "serve"], cwd: dir,
      env: { ...process.env, TELEX_STATE: state, TELEX_CONFIG: config, TELEX_PROJECT_CONFIG: join(dir, ".telex.json") } }));
    for (let n = 0; n < 100 && !readFileSync(log, "utf8").includes("session started"); n++) await new Promise((resolve) => setTimeout(resolve, 20));
    const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls().filter((call) => call.text?.includes("session started")).length, 1);
    assert.match(calls()[0].text, /main · codex/);
    await invokeCodexHook({ ...input, hook_event_name: "Stop" }, state);
    assert.equal(calls().filter((call) => call.text?.includes("session ended")).length, 0);
    await invokeCodexHook({ ...input, hook_event_name: "SessionEnd" }, state);
    for (let n = 0; n < 100 && !calls().some((call) => call.text?.includes("session ended")); n++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls().filter((call) => call.text?.includes("session ended")).length, 1);
    await client.listTools();
    await client.close();
    assert.equal(calls().filter((call) => call.text?.includes("session ended")).length, 1);
  } finally { await client.close(); process.title = originalTitle; }
});
