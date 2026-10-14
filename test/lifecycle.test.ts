import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { announceSession, finishSession, sweepSessions, sessionProcessAlive, type LifecycleSend } from "../src/lifecycle.ts";
import { fileRoutes } from "../src/routes.ts";

function fixture(configured = true) {
  const dir = mkdtempSync(join(tmpdir(), "telex-lifecycle-"));
  process.env.TELEX_STATE = join(dir, "sessions.json");
  process.env.TELEX_CONFIG = join(dir, "config.json");
  delete process.env.TELEX_PROJECT_CONFIG;
  const bot = { token: "123:test", chatId: 7 };
  writeFileSync(process.env.TELEX_CONFIG, JSON.stringify({ bots: { main: bot } }));
  if (configured) writeFileSync(join(dir, ".telex.json"), JSON.stringify({ bot: "main" }));
  const messages: string[] = [];
  const send: LifecycleSend = async (_bot, _record, text) => { messages.push(text); };
  return { dir, bot, messages, send, input: { id: "session-1", botName: "main", bot, provider: "codex", project: dir, root: true } };
}

test("lifecycle announces once, leaves live idle process alive, and ends once across reloads", async () => {
  const f = fixture();
  await announceSession(f.input, f.send);
  await announceSession(f.input, f.send);
  await sweepSessions(f.send);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /started\nBot: main\nAgent: codex\nSession: session-1/);
  assert.match(f.messages[0], /Repository:/);
  await Promise.all([finishSession(f.input.id, "ended", f.send), finishSession(f.input.id, "ended", f.send)]);
  await sweepSessions(f.send);
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1], /session ended/);
  assert.equal(sessionProcessAlive({ pid: process.pid, processStart: "recycled-pid" }), false);
});

test("unconfigured project tracks cleanup without automatic startup notification", async () => {
  const f = fixture(false);
  await announceSession(f.input, f.send);
  await sweepSessions(f.send);
  assert.deepEqual(f.messages, []);
  assert.equal(readdirSync(join(f.dir, "lifecycle")).filter((name) => name.endsWith(".json")).length, 1);
});

test("process exit generates one durable crash disposition, never idle timeout", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await announceSession({ ...f.input, pid: child.pid }, f.send);
    writeFileSync(join(f.dir, "lifecycle", "corrupt.json"), "not-json");
    await sweepSessions(f.send);
    assert.equal(f.messages.length, 1);
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await sweepSessions(f.send);
    await sweepSessions(f.send);
    assert.equal(f.messages.length, 2);
    assert.match(f.messages[1], /terminated unexpectedly/);
    const path = join(f.dir, "lifecycle", readdirSync(join(f.dir, "lifecycle")).find((name) => name.endsWith(".json"))!);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).end, "sent");
  } finally { child.kill(); }
});

test("root resume keeps one start and one end while refreshing the live host owner", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await announceSession({ ...f.input, pid: child.pid }, f.send);
    await announceSession({ ...f.input, pid: process.pid }, f.send);
    await Promise.all([finishSession(f.input.id, "ended", f.send), finishSession(f.input.id, "ended", f.send)]);
    assert.equal(f.messages.length, 2);
    const path = join(f.dir, "lifecycle", readdirSync(join(f.dir, "lifecycle")).find((name) => name.endsWith(".json"))!);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
  } finally { child.kill(); }
});

test("suppressed child lifecycle records stay silent through crash sweeping", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await announceSession({ ...f.input, id: "child-session", root: false, pid: child.pid }, f.send);
    const exited = once(child, "exit"); child.kill(); await exited;
    await sweepSessions(f.send);
    await sweepSessions(f.send);
    assert.deepEqual(f.messages, []);
    const path = join(f.dir, "lifecycle", readdirSync(join(f.dir, "lifecycle")).find((name) => name.endsWith(".json"))!);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).start, "suppressed");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).end, "suppressed");
  } finally { child.kill(); }
});

test("unattested generic MCP lifecycle stays suppressed and cannot rewrite a root record", async () => {
  const f = fixture();
  await announceSession({ ...f.input, id: "generic-mcp", root: undefined }, f.send);
  await finishSession("generic-mcp", "ended", f.send);
  assert.deepEqual(f.messages, []);

  const root = fixture();
  await announceSession({ ...root.input, id: "shared-root", routeId: "root-route" }, root.send);
  await announceSession({ ...root.input, id: "shared-root", root: false, provider: "child", routeId: "child-route", pid: process.pid + 1 }, root.send);
  const path = join(root.dir, "lifecycle", readdirSync(join(root.dir, "lifecycle")).find((name) => name.endsWith(".json") &&
    JSON.parse(readFileSync(join(root.dir, "lifecycle", name), "utf8")).id === "shared-root")!);
  const record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(record.provider, "codex");
  assert.equal(record.routeId, "root-route");
  assert.equal(record.pid, process.pid);
  assert.equal(root.messages.filter((text) => text.includes("session started")).length, 1);
});

test("failed termination notification removes routing and is not replayed after restart", async () => {
  const f = fixture();
  const routes = fileRoutes(f.bot.token);
  routes.register({ id: "route", chatId: 7, provider: "codex", repo: f.dir, branch: "main", worktree: f.dir });
  await announceSession({ ...f.input, routeId: "route" }, f.send);
  let attempts = 0;
  await assert.rejects(finishSession(f.input.id, "ended", async () => { attempts++; throw new Error("network uncertain"); }));
  await finishSession(f.input.id, "ended", f.send);
  await sweepSessions(f.send);
  assert.equal(attempts, 1);
  assert.equal(routes.get("route"), undefined);
});

test("default lifecycle transport is bounded and termination closes routing before network I/O", async () => {
  const f = fixture();
  const routes = fileRoutes(f.bot.token);
  routes.register({ id: "bounded", chatId: 7, provider: "codex", repo: f.dir, branch: "main", worktree: f.dir });
  await announceSession({ ...f.input, routeId: "bounded" }, f.send);
  const original = globalThis.fetch;
  let bounded = false;
  globalThis.fetch = async (_url, options) => {
    bounded = options?.signal instanceof AbortSignal;
    assert.equal(routes.get("bounded"), undefined);
    throw new Error("offline mock");
  };
  try { await assert.rejects(finishSession(f.input.id), /offline mock/); }
  finally { globalThis.fetch = original; }
  assert.equal(bounded, true);
  assert.equal(routes.get("bounded"), undefined);
});

test("sweeping an old lifetime cannot overwrite or remove a resumed route", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const routes = fileRoutes(f.bot.token);
  routes.register({ id: "stable-route", chatId: 7, provider: "codex", repo: f.dir, branch: "main", worktree: f.dir, pid: child.pid });
  await announceSession({ ...f.input, pid: child.pid, routeId: "stable-route" }, f.send);
  const exited = once(child, "exit"); child.kill(); await exited;
  routes.register({ id: "stable-route", chatId: 7, provider: "codex", repo: f.dir, branch: "main", worktree: f.dir, pid: process.pid });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: { message_id: 123 } }) }) as Response;
  try { await sweepSessions(); } finally { globalThis.fetch = original; }
  assert.equal(routes.get("stable-route")?.pid, process.pid);
  assert.equal(routes.message(7, 123), undefined, "old termination reply cannot target the resumed lifetime");
});

test("a changed bot alias cannot redirect lifetime metadata and cleans the original route", async () => {
  const f = fixture();
  const routes = fileRoutes(f.bot.token);
  routes.register({ id: "original", chatId: 7, provider: "codex", repo: f.dir, branch: "main", worktree: f.dir, pid: process.pid });
  await announceSession({ ...f.input, routeId: "original" }, f.send);
  writeFileSync(process.env.TELEX_CONFIG!, JSON.stringify({ bots: { main: { token: "456:replacement", chatId: 88 } } }));
  await finishSession(f.input.id, "ended", f.send);
  assert.equal(f.messages.length, 1, "no metadata is sent to the replacement destination");
  assert.equal(routes.get("original"), undefined);
});
