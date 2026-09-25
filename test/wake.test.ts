import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileInbox } from "../src/inbox.ts";
import { Wake, fitsWidth, probe, promptFor, submitToPane, wakeTargetFromConfig } from "../src/wake.ts";
import { BotSession, type Incoming } from "../src/telegram.ts";
import { touch } from "../src/registry.ts";

const tmux = (socket: string, ...args: string[]) =>
  execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 3000 }).trim();

const message = (id: number, text: string, from_id = 7, receipt_id = 100 + id): Incoming =>
  ({ message_id: id, text, from_id, receipt_id, received_at: Date.now() });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  // Node 24 names its main thread `MainThread` even when launched through a `codex` symlink.
  process.title = "codex";
  const dir = process.env.TELEX_WAKE_FIXTURE_DIR!;
  const socket = join(dir, "socket");
  const session = "wake_test";
  const pane = tmux(socket, "display-message", "-p", "#{pane_id}");
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const info = lstatSync(socket);
  const target = { socket, session, pane, pid: process.pid, start, socketId: `${info.dev}:${info.ino}` };
  const screen = (text: string, shortcut = "? for shortcuts  ⚠ 1 warning · f2 to view") => process.stdout.write(
    `\x1b[2J\x1b[H${text}\n  GPT-6-Luna default\n  ${shortcut}\n`
  );
  const render = async (text: string, shortcut?: string) => {
    screen(text, shortcut);
    for (let n = 0; n < 50; n++) {
      const shown = tmux(socket, "capture-pane", "-p", "-t", pane);
      if (shown.includes(text) && shown.includes(shortcut ?? "? for shortcuts  ⚠ 1 warning · f2 to view")) return;
      await sleep(20);
    }
    throw new Error(`tmux did not render ${text}`);
  };
  const terminalInput = () => new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("terminal did not receive Enter")), 3000);
    process.stdin.setRawMode(true);
    process.stdin.once("data", (chunk: Buffer) => {
      screen(`› ${chunk.toString("utf8")}`);
      process.stdin.once("data", (enter: Buffer) => {
        clearTimeout(timeout);
        resolve((chunk.toString("utf8") + enter.toString("utf8")).replace(/\r$/, "\n"));
      });
    });
    process.stdin.resume();
  });

  await render("› Ask Codex to do anything");
  assert.equal(probe(target), true, "detached empty editor");
  await render("› Ask Codex to do anything", "? for shortcuts Run command?");
  assert.equal(probe(target), false, "unknown footer stays blocked");
  await render("› Ask Codex to do anything");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ bots: { main: { token: "123:test", chatId: 7, allowFrom: [7] } } }));
  process.env.TELEX_CONFIG = join(dir, "config.json");
  process.env.TELEX_PROJECT_CONFIG = join(dir, "project.json");
  process.env.TELEX_WAKE_CONFIG = join(dir, "wake.json");
  process.env.TELEX_STATE = join(dir, "sessions.json");
  const bind = () => execFileSync(process.execPath,
    [fileURLToPath(new URL("../../dist/cli.js", import.meta.url)), "wake", "bind", pane, "--socket", socket],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  assert.throws(bind, /Default daemon-hosted Codex cannot bind/, "a pane without its own MCP child cannot enroll");
  const mcp = spawn("sleep", ["300"], { stdio: "ignore" });
  touch({ session_id: "fixture", bot: createHash("sha256").update("123:test").digest("hex"),
    project: process.cwd(), agent: "codex", pid: mcp.pid!, interval_seconds: 60 });
  bind();
  mcp.kill();
  assert.deepEqual(wakeTargetFromConfig(), target, "enrollment resolves this exact pane");

  await render("Working (esc to interrupt)");
  assert.equal(probe(target), false, "busy editor");
  await render("› draft text");
  assert.equal(probe(target), false, "draft editor");
  await render("Approve this command? Allow Deny");
  assert.equal(probe(target), false, "approval prompt");
  await render("› Ask Codex to do anything");
  assert.equal(probe({ ...target, pid: process.ppid }), false, "replacement PID");
  assert.equal(probe({ ...target, socketId: "0:0" }), false, "replacement socket");

  const client = spawn("tmux", ["-S", socket, "-C", "attach-session", "-t", session],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TMUX: "" } });
  try {
    for (let n = 0; n < 50 && !tmux(socket, "list-clients", "-t", session, "-F", "#{client_name}"); n++) await sleep(20);
    assert.notEqual(tmux(socket, "list-clients", "-t", session, "-F", "#{client_name}"), "", "fixture client attached");
    assert.equal(probe(target), false, "attached session");
  } finally {
    client.kill();
    for (let n = 0; n < 50 && tmux(socket, "list-clients", "-t", session, "-F", "#{client_name}"); n++) await sleep(20);
  }

  await render("› Ask Codex to do anything");
  const prompt = promptFor("Hej 👋\nsecond line")!;
  const received = terminalInput();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TELEX_WAKE_SUBMIT: "1", TELEX_WAKE_TARGET: JSON.stringify(target), TELEX_WAKE_PROMPT: prompt },
    stdio: "ignore",
  });
  const sent = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  assert.equal(await received, `${prompt}\n`, "one physical line and one Enter");
  assert.equal(await sent, 0, "terminal sender exited cleanly");

  process.env.TELEX_INBOX = join(dir, "inbox.json");
  const store = fileInbox();
  store.push("7", message(10, "wrong sender", 8));
  store.push("7", { ...message(11, "wake me"), receipt_id: undefined });
  store.push("7", message(12, "later"));
  store.receipt("7", 11, 111);
  const edits: string[] = [];
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TELEX_WAKE_WORKER: "1", TELEX_WAKE_TARGET: JSON.stringify(target) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let workerError = "";
  worker.stderr?.on("data", (chunk: Buffer) => { workerError += chunk.toString("utf8"); });
  worker.on("message", (event: { type: string; text?: string }) => {
    if (event.type === "edit") edits.push(event.text!);
  });
  try {
    await render("› Ask Codex to do anything");
    const submitted = terminalInput();
    assert.equal(await submitted, `${promptFor("wake me")}\n`, "Wake submits exactly one prompt");
    assert.deepEqual(store.claimed("7").map((m) => m.message_id), [11], "paste keeps the claim until host confirmation");
    assert.equal(edits.length, 1, "uncertain receipt is edited before paste");
    assert.match(edits[0], /Submitting to Codex/);
    worker.send({ type: "confirm" });
    for (let n = 0; n < 50 && edits.length < 2; n++) await sleep(20);
    assert.equal(edits.length, 2);
    assert.deepEqual(store.claimed("7").map((m) => m.message_id), [11], "claim remains until confirmation receipt succeeds");
    worker.send({ type: "release" });
    for (let n = 0; n < 50 && store.claimed("7").length; n++) await sleep(20);
    assert.deepEqual(store.claimed("7"), []);
    assert.deepEqual(store.take("7").map((m) => m.message_id), [10, 12], "unauthorized and later messages remain queued");
  } finally { worker.kill(); }
  assert.equal(workerError.replace(/^unknown buffer:.*\n/gm, ""), "", "Wake worker had no terminal error");
}

if (process.env.TELEX_WAKE_WORKER) {
  const target = JSON.parse(process.env.TELEX_WAKE_TARGET!);
  let release!: () => void;
  const confirmation = new Promise<void>((resolve) => { release = resolve; });
  const botSession = new BotSession(async (method, params) => {
    assert.equal(method, "editMessageText");
    process.send?.({ type: "edit", text: params.text });
    if (String(params.text).includes("Submitted to Codex")) await confirmation;
    return {};
  });
  botSession.setInboxStore(fileInbox());
  const wake = new Wake(target, { token: "123:test", chatId: 7, allowFrom: [7] }, botSession);
  process.on("message", (event: { type: string }) => {
    if (event.type === "confirm") wake.onHook("UserPromptSubmit", "host-1", [], false, promptFor("wake me"));
    if (event.type === "release") release();
  });
  wake.onHook("Stop", "host-1", [], false);
} else if (process.env.TELEX_WAKE_SUBMIT) {
  try { submitToPane(JSON.parse(process.env.TELEX_WAKE_TARGET!), process.env.TELEX_WAKE_PROMPT!, "fixture"); }
  catch (err) { writeFileSync(join(process.env.TELEX_WAKE_FIXTURE_DIR!, "submit-error"), String(err)); process.exitCode = 1; }
} else if (process.env.TELEX_WAKE_FIXTURE_DIR) {
  void fixture().then(
    () => writeFileSync(join(process.env.TELEX_WAKE_FIXTURE_DIR!, "result"), "ok"),
    (err: unknown) => writeFileSync(join(process.env.TELEX_WAKE_FIXTURE_DIR!, "result"),
      `${String(err)}\n${tmux(join(process.env.TELEX_WAKE_FIXTURE_DIR!, "socket"), "capture-pane", "-p", "-t", "wake_test")}`),
  );
} else {
  test("prompt encodes Unicode and multiline text as one physical line and rejects controls", () => {
    assert.equal(promptFor("Hej 👋\nline\u2028next"), 'Telegram user message: "Hej 👋\\nline\\u2028next"');
    assert.equal(fitsWidth(100, promptFor("Hej 👋\nline")!), true);
    assert.equal(fitsWidth(40, promptFor("a".repeat(100))!), false, "wrapped prompts stay in the ordinary inbox");
    for (const text of ["", "a\rb", "a\0b", "a\u001bb", "a\u0085b"]) assert.equal(promptFor(text), undefined);
  });

  test("claims are exclusive across processes and need the matching acknowledgement", () => {
    const dir = mkdtempSync(join(tmpdir(), "telex-wake-inbox-"));
    const old = process.env.TELEX_INBOX;
    process.env.TELEX_INBOX = join(dir, "inbox.json");
    try {
      const poller = fileInbox();
      const waker = fileInbox();
      poller.push("chat", message(1, "allowed"));
      poller.push("chat", message(2, "wrong sender", 8));
      poller.push("chat", { ...message(3, "no receipt"), receipt_id: undefined });
      const allowed = (m: Incoming) => m.from_id === 7 && m.receipt_id !== undefined && promptFor(m.text) !== undefined;
      assert.equal(waker.claim("chat", "first", allowed)?.message_id, 1);
      assert.equal(poller.claim("chat", "second", allowed), undefined, "another process cannot claim while a wake is uncertain");
      assert.deepEqual(poller.take("chat").map((m) => m.message_id), [2, 3], "ordinary collection cannot replay a claim");
      assert.equal(fileInbox().ack("chat", "wrong"), undefined);
      assert.deepEqual(fileInbox().claimed("chat").map((m) => m.message_id), [1], "a crash leaves the claim visible");
      assert.equal(fileInbox().ack("chat", "first")?.message_id, 1);
      assert.deepEqual(fileInbox().claimed("chat"), []);

      poller.push("late", { ...message(4, "receipt pending"), receipt_id: undefined });
      assert.equal(waker.claim("late", "early", allowed), undefined, "no wake before Telegram's receipt exists");
      poller.receipt("late", 4, 104);
      assert.equal(waker.claim("late", "after-receipt", allowed)?.receipt_id, 104);
      assert.equal(poller.resolve("late", 4, true)?.message_id, 4, "explicit recovery requeues an uncertain claim");
      assert.equal(waker.claim("late", "retry", allowed)?.message_id, 4);
      assert.equal(poller.resolve("late", 4, false)?.message_id, 4, "explicit dismissal removes it");
      assert.deepEqual(waker.claimed("late"), []);
    } finally {
      if (old === undefined) delete process.env.TELEX_INBOX;
      else process.env.TELEX_INBOX = old;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a busy inbox lock times out without changing a queued message", () => {
    const dir = mkdtempSync(join(tmpdir(), "telex-wake-lock-"));
    const old = process.env.TELEX_INBOX;
    const path = join(dir, "inbox.json");
    process.env.TELEX_INBOX = path;
    try {
      const store = fileInbox();
      store.push("chat", message(1, "keep me"));
      const before = readFileSync(path, "utf8");
      writeFileSync(`${path}.lock`, "held");
      assert.throws(() => store.claim("chat", "must-not-claim", () => true), /lock timed out/);
      assert.equal(readFileSync(path, "utf8"), before);
    } finally {
      if (old === undefined) delete process.env.TELEX_INBOX;
      else process.env.TELEX_INBOX = old;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wake probes and submits through a private tmux socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telex-wake-tmux-"));
    const socket = join(dir, "socket");
    const codex = join(dir, "codex");
    symlinkSync(process.execPath, codex);
    try {
      const script = fileURLToPath(import.meta.url);
      tmux(socket, "new-session", "-d", "-s", "wake_test", "-x", "100", "-y", "24", `exec env TELEX_WAKE_FIXTURE_DIR='${dir}' '${codex}' '${script}'`);
      let result = "";
      for (let n = 0; n < 200; n++) {
        try { result = readFileSync(join(dir, "result"), "utf8"); break; } catch { await sleep(25); }
      }
      assert.equal(result, "ok", result || `tmux fixture timed out: ${tmux(socket, "capture-pane", "-p", "-t", "wake_test")}`);
    } finally {
      try { tmux(socket, "kill-server"); } catch { /* fixture already exited */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
