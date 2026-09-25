import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

test("CLI adds, modifies, routes, and removes a bot", () => {
  const dir = mkdtempSync(join(tmpdir(), "telex-cli-"));
  const config = join(dir, "config.json");
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, TELEX_CONFIG: config },
  });

  run("add", "main", "--token", "123:abc", "--chat-id", "7", "--allow", "42");
  run("set", "main", "--chat-id=-1007", "--allow", "42,43");
  run("project", "main");
  const listed = JSON.parse(run("list", "--json"));
  assert.equal(listed.bots.main.chatId, -1007);
  assert.deepEqual(listed.bots.main.allowFrom, [42, 43]);
  assert.notEqual(listed.bots.main.token, "123:abc");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".telex.json"), "utf8")), { bot: "main" });
  run("remove", "main");
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).bots, {});
});
