import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

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

test("config offers only plugin hosts and rejects removed shortcuts without writing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "telex-config-"));
  const config = join(dir, "bots.json");
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, TELEX_CONFIG: config };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env });

  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--agent <id>\s+skip the prompts: claude, codex/);
  const printed = run("config", "--print");
  assert.equal(printed.status, 0);
  assert.match(printed.stdout, /Claude Code/);
  assert.match(printed.stdout, /Codex CLI/);
  assert.doesNotMatch(printed.stdout, /Gemini|Qwen|Cursor|Roo|VS Code|Zed|Amp|opencode|Crush/);

  for (const removed of ["gemini", "qwen", "cursor", "roo", "vscode", "zed", "amp", "opencode", "crush"]) {
    const result = run("config", "--agent", removed, "--scope", "project");
    assert.equal(result.status, 1, removed);
    assert.match(result.stderr, /Known: claude, codex/, removed);
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(existsSync(config), false);
  assert.deepEqual(JSON.parse(run("config", "--json").stdout).mcpServers.telex, { command: "telex", args: ["serve"] });
});

test("CLI installs the bundled plugin through each host and reuses its marketplace", () => {
  const dir = mkdtempSync(join(tmpdir(), "telex-install-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.json");
  const state = join(dir, "marketplaces.json");
  writeFileSync(state, "{}");
  const fake = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const host = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const log = fs.existsSync(process.env.TELEX_TEST_LOG) ? JSON.parse(fs.readFileSync(process.env.TELEX_TEST_LOG, "utf8")) : [];
log.push({ host, args });
fs.writeFileSync(process.env.TELEX_TEST_LOG, JSON.stringify(log));
if (args.join(" ") === process.env.TELEX_TEST_FAIL) {
  console.error("provider install failed");
  process.exit(17);
}
const state = JSON.parse(fs.readFileSync(process.env.TELEX_TEST_STATE, "utf8"));
if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
  console.log(JSON.stringify(host === "codex"
    ? { marketplaces: state[host] ? [{ name: "telex", root: state[host], marketplaceSource: { source: state[host] } }] : [] }
    : state[host] ? [{ name: "telex", source: "directory", path: state[host] }] : []));
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  state[host] = args[3];
  fs.writeFileSync(process.env.TELEX_TEST_STATE, JSON.stringify(state));
}
`;
  for (const host of ["codex", "claude"]) {
    const file = join(bin, host);
    writeFileSync(file, fake);
    chmodSync(file, 0o755);
  }
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const marketplace = fileURLToPath(new URL("../../plugins/", import.meta.url));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TELEX_TEST_LOG: log, TELEX_TEST_STATE: state };
  const run = (provider: string) => execFileSync(process.execPath, [cli, "install", provider], { cwd: dir, encoding: "utf8", env });

  assert.match(run("codex"), /Start a new Codex session/);
  assert.match(run("claude"), /Start a new Claude session/);
  run("codex");
  assert.match(run("claude"), /reload-plugins/);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
    { host: "codex", args: ["plugin", "marketplace", "list", "--json"] },
    { host: "codex", args: ["plugin", "marketplace", "add", marketplace] },
    { host: "codex", args: ["plugin", "add", "telex@telex"] },
    { host: "claude", args: ["plugin", "marketplace", "list", "--json"] },
    { host: "claude", args: ["plugin", "marketplace", "add", marketplace, "--scope", "user"] },
    { host: "claude", args: ["plugin", "install", "telex@telex", "--scope", "user"] },
    { host: "codex", args: ["plugin", "marketplace", "list", "--json"] },
    { host: "codex", args: ["plugin", "add", "telex@telex"] },
    { host: "claude", args: ["plugin", "marketplace", "list", "--json"] },
    { host: "claude", args: ["plugin", "marketplace", "add", marketplace, "--scope", "user"] },
    { host: "claude", args: ["plugin", "install", "telex@telex", "--scope", "user"] },
  ]);

  const calls = JSON.parse(readFileSync(log, "utf8")).length;
  writeFileSync(state, JSON.stringify({ codex: join(dir, "other-marketplace"), claude: marketplace }));
  const collision = spawnSync(process.execPath, [cli, "install", "codex"], { cwd: dir, encoding: "utf8", env });
  assert.equal(collision.status, 1);
  assert.match(collision.stderr, /already points elsewhere/);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")).slice(calls), [
    { host: "codex", args: ["plugin", "marketplace", "list", "--json"] },
  ]);

  const failure = spawnSync(process.execPath, [cli, "install", "claude"], {
    cwd: dir, encoding: "utf8", env: { ...env, TELEX_TEST_FAIL: "plugin install telex@telex --scope user" },
  });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /provider install failed/);
});
