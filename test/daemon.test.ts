import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemon, startDaemon } from "../src/daemon.ts";
import type { BotSession } from "../src/telegram.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "telex-daemon-"));
  process.env.TELEX_STATE = join(dir, "sessions.json");
  process.env.TELEX_CONFIG = join(dir, "config.json");
  return dir;
}

test("listener singleton rejects concurrent starts and restarts after orderly or stale ownership", () => {
  const dir = fixture();
  const release = acquireDaemon();
  assert.throws(() => acquireDaemon(), /already running/);
  release();
  const second = acquireDaemon();
  second();
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ id: "old", pid: process.pid, processStart: "old process" }));
  const recovered = acquireDaemon();
  assert.throws(() => acquireDaemon(), /already running/);
  recovered();
});

test("listener listens once per token and applies add/remove without a restart", () => {
  fixture();
  const write = (bots: Record<string, { token: string; chatId: number }>) =>
    writeFileSync(process.env.TELEX_CONFIG!, JSON.stringify({ bots }));
  write({ first: { token: "123:first", chatId: 7 }, alias: { token: "123:first", chatId: 8 } });
  const calls: string[] = [];
  const daemon = startDaemon((token) => ({
    setAnswerStore() {}, setRouteStore() {},
    setPollingOwner(owner: boolean) { calls.push(`${token}:owner:${owner}`); },
    listen() { calls.push(`${token}:listen`); },
    stop() { calls.push(`${token}:stop`); },
  }) as unknown as BotSession);
  try {
    assert.equal(calls.filter((call) => call.endsWith(":listen")).length, 1);
    assert.throws(() => startDaemon(), /already running/);
    write({ second: { token: "123:second", chatId: 7 } });
    daemon.reconcile();
    assert.ok(calls.includes("123:first:stop"));
    assert.ok(calls.includes("123:second:listen"));
    write({});
    daemon.reconcile();
    assert.ok(calls.includes("123:second:stop"));
  } finally { daemon.stop(); daemon.stop(); }
});
