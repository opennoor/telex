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
  run("set-timeouts", "--queue-expiry", "7200", "--question-timeout", "900");
  run("project", "main");
  const listed = JSON.parse(run("list", "--json"));
  assert.equal(listed.bots.main.chatId, -1007);
  assert.deepEqual(listed.bots.main.allowFrom, [42, 43]);
  assert.notEqual(listed.bots.main.token, "123:abc");
  assert.equal(listed.queueExpirySeconds, 7200);
  assert.equal(listed.questionTimeoutSeconds, 900);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".telex.json"), "utf8")), { bot: "main" });
  run("remove", "main");
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).bots, {});
});

test("CLI rejects invalid timeout settings without changing config", () => {
  const dir = mkdtempSync(join(tmpdir(), "telex-timeouts-"));
  const config = join(dir, "config.json");
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, TELEX_CONFIG: config };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env });

  assert.equal(run("add", "main", "--token", "123:abc", "--chat-id", "7").status, 0);
  const before = readFileSync(config, "utf8");
  const invalid = run("set-timeouts", "--queue-expiry", "0", "--question-timeout", "900");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--queue-expiry must be an integer/);
  assert.equal(readFileSync(config, "utf8"), before);
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
  assert.deepEqual(JSON.parse(run("config", "--agent", "claude", "--channel", "--json").stdout).mcpServers.telex,
    { command: "telex", args: ["serve", "--channel"] });
  assert.equal(run("config", "--agent", "codex", "--channel", "--json").status, 1);
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

test("CLI manages the user service through mocked systemctl", () => {
  const dir = mkdtempSync(join(tmpdir(), "telex-service-cli-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "systemctl.jsonl");
  const executable = join(bin, "systemctl");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.TELEX_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.TELEX_TEST_FAIL) { console.error("user manager unavailable"); process.exit(1); }
console.log("service status");
`);
  chmodSync(executable, 0o755);
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(dir, "config"),
    TELEX_CONFIG: join(dir, "bots.json"), TELEX_STATE: join(dir, "state", "sessions.json"), TELEX_TEST_LOG: log };
  const run = (action: string) => execFileSync(process.execPath, [cli, "service", action], { cwd: dir, encoding: "utf8", env });
  assert.match(run("install"), /Installed and started/);
  const unit = join(dir, "config", "systemd", "user", "telex.service");
  assert.ok(readFileSync(unit, "utf8").includes(`${cli}" daemon`));
  run("stop"); run("start");
  assert.equal(run("status").trim(), "service status");
  run("uninstall");
  assert.equal(existsSync(unit), false);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
    ["--user", "daemon-reload"], ["--user", "enable", "--now", "telex.service"],
    ["--user", "stop", "telex.service"], ["--user", "start", "telex.service"],
    ["--user", "status", "--no-pager", "telex.service"],
    ["--user", "disable", "--now", "telex.service"], ["--user", "daemon-reload"],
  ]);
  const failure = spawnSync(process.execPath, [cli, "service", "start"], {
    cwd: dir, encoding: "utf8", env: { ...env, TELEX_TEST_FAIL: "1" },
  });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /user manager unavailable/);
});

test("wake disable retains exact recovery identity and cannot recover another route's claim", async () => {
  const { createHash } = await import("node:crypto");
  const { fileInbox, scopedInbox } = await import("../src/inbox.ts");
  const { fileRoutes } = await import("../src/routes.ts");
  const dir = mkdtempSync(join(tmpdir(), "telex-wake-recovery-"));
  const config = join(dir, "config.json");
  const state = join(dir, "sessions.json");
  const inbox = join(dir, "inbox.json");
  const wake = join(dir, "wake.json");
  const log = join(dir, "api.json");
  const token = "123:test";
  const hash = createHash("sha256").update(token).digest("hex");
  const oldState = process.env.TELEX_STATE;
  const oldInbox = process.env.TELEX_INBOX;
  process.env.TELEX_STATE = state;
  process.env.TELEX_INBOX = inbox;
  const route = { id: "exact-route", chatId: 7, provider: "codex", botName: "main", repo: dir,
    branch: "topic", worktree: dir, pid: process.pid };
  writeFileSync(config, JSON.stringify({ bots: { main: { token, chatId: 7 } } }));
  writeFileSync(wake, "{}");
  writeFileSync(`${wake}.recovery.json`, JSON.stringify({ botHash: hash, chatId: 7, route }));
  fileRoutes(token).register(route);
  const exact = scopedInbox(fileInbox(), `${hash}:exact-route`);
  const other = scopedInbox(fileInbox(), `${hash}:other-route`);
  for (const [store, id] of [[exact, 11], [other, 22]] as const) {
    store.push("7", { message_id: id, receipt_id: id + 100, text: `message-${id}`, received_at: Date.now() });
    store.claim("7", `wake-${id}`, () => true);
  }
  const preload = join(dir, "telegram.mjs");
  writeFileSync(preload, `import { writeFileSync } from "node:fs";
    globalThis.fetch = async (_url, options) => { writeFileSync(${JSON.stringify(log)}, options.body);
      return { json: async () => ({ ok: true, result: {} }) }; };`);
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const env = { ...process.env, TELEX_CONFIG: config, TELEX_PROJECT_CONFIG: join(dir, ".telex.json"),
    TELEX_STATE: state, TELEX_INBOX: inbox, TELEX_WAKE_CONFIG: wake };
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", preload, cli, "wake", ...args], { cwd: dir, encoding: "utf8", env });
  try {
    run("disable");
    assert.equal(existsSync(wake), false);
    assert.equal(existsSync(`${wake}.recovery.json`), true);
    assert.match(run("pending"), /11\tmessage-11/);
    assert.doesNotMatch(run("pending"), /message-22/);
    assert.throws(() => run("recover", "22", "--delivered"), /no pending wake claim/);
    run("recover", "11", "--delivered");
    assert.deepEqual(exact.claimed("7"), []);
    assert.equal(other.claimed("7")[0].message_id, 22);
    assert.match(JSON.parse(readFileSync(log, "utf8")).text, /main · codex/);
    assert.match(JSON.parse(readFileSync(log, "utf8")).text, /Delivered|Submitted/);
    assert.equal(fileRoutes(token).get(route.id)?.pid, process.pid, "recovery never overwrites a live route");
  } finally {
    if (oldState === undefined) delete process.env.TELEX_STATE; else process.env.TELEX_STATE = oldState;
    if (oldInbox === undefined) delete process.env.TELEX_INBOX; else process.env.TELEX_INBOX = oldInbox;
  }
});
