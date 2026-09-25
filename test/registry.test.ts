import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touch, release, isLive, repoOf, ownerOf, statePath, type Session } from "../src/registry.ts";

function isolated() {
  process.env.TELEX_STATE = join(mkdtempSync(join(tmpdir(), "telex-")), "sessions.json");
  return () => JSON.parse(readFileSync(statePath(), "utf8")).sessions as Session[];
}

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const entry = (over: Partial<Session> = {}) => ({
  session_id: SESSION,
  bot: "work",
  project: "/code/acme",
  repo: "/code/acme",
  agent: "claude-code",
  pid: process.pid,
  interval_seconds: 60,
  ...over,
});

const alive = (over: Partial<Session>): Session => {
  const stamp = new Date().toISOString();
  return { ...entry(over), started_at: stamp, last_seen: stamp } as Session;
};

test("one session keeps one record however it names itself", (t) => {
  const sessions = isolated();
  t.after(() => release(SESSION));

  assert.deepEqual(touch(entry()), [], "nothing else is running yet");
  // The same session, a different agent name and a different process: still one agent.
  const others = touch(entry({ agent: "claude-code:subagent", pid: process.ppid }));

  assert.deepEqual(others, [], "a renamed session is not a second agent");
  assert.equal(sessions().length, 1);
  assert.equal(sessions()[0].agent, "claude-code:subagent");
});

test("a different session on the same bot is reported", (t) => {
  const sessions = isolated();
  t.after(() => release(SESSION));
  writeFileSync(statePath(), JSON.stringify({ sessions: [alive({ session_id: OTHER, project: "/code/other", repo: "/code/other", agent: "codex" })] }));

  const others = touch(entry());
  assert.deepEqual(others.map((s) => s.agent), ["codex"]);
  assert.equal(sessions().length, 2);
});

test("two worktrees of one repository are one project, not a clash", (t) => {
  const sessions = isolated();
  t.after(() => release(SESSION));
  writeFileSync(
    statePath(),
    JSON.stringify({ sessions: [alive({ session_id: OTHER, project: "/code/acme.worktrees/fix", repo: "/code/acme" })] }),
  );

  assert.deepEqual(touch(entry()), [], "same repo, different worktree");
  assert.equal(sessions().length, 2, "both are still recorded");
});

test("a session on a different bot is never a clash", (t) => {
  isolated();
  t.after(() => release(SESSION));
  writeFileSync(statePath(), JSON.stringify({ sessions: [alive({ session_id: OTHER, bot: "alerts", project: "/code/other", repo: "/code/other" })] }));
  assert.deepEqual(touch(entry()), []);
});

test("a dead process is forgotten rather than warned about", (t) => {
  const sessions = isolated();
  t.after(() => release(SESSION));
  // A never-allocated high pid stands in for a crashed agent.
  writeFileSync(statePath(), JSON.stringify({ sessions: [alive({ session_id: OTHER, pid: 2 ** 22, project: "/code/gone", repo: "/code/gone" })] }));

  assert.deepEqual(touch(entry()), []);
  assert.deepEqual(sessions().map((s) => s.project), ["/code/acme"]);
});

test("a live process that stopped checking in is stale after three intervals", () => {
  const now = Date.now();
  const session = alive({ interval_seconds: 30 });
  session.last_seen = new Date(now - 100_000).toISOString();
  assert.equal(isLive(session, now), false, "100s is past three 30s beats");
  assert.equal(isLive({ ...session, last_seen: new Date(now - 60_000).toISOString() }, now), true);
});

test("started_at survives a re-check-in, last_seen moves", (t) => {
  const sessions = isolated();
  t.after(() => release(SESSION));
  touch(entry(), Date.parse("2026-09-17T10:00:00.000Z"));
  touch(entry(), Date.parse("2026-09-17T10:05:00.000Z"));
  const [mine] = sessions();
  assert.equal(mine.started_at, "2026-09-17T10:00:00.000Z");
  assert.equal(mine.last_seen, "2026-09-17T10:05:00.000Z");
});

test("repoOf reports the same repository for a worktree as for its main checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "telex-repo-"));
  const main = join(root, "main");
  mkdirSync(main);
  const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", main], { stdio: "ignore" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(main, "f"), "x");
  git("add", "-A");
  git("commit", "-qm", "init");
  const tree = join(root, "wt");
  git("worktree", "add", "-q", tree, "-b", "side");

  assert.equal(repoOf(tree), repoOf(main), "a worktree resolves to its repository");
  assert.equal(repoOf(join(root, "not-a-repo")), join(root, "not-a-repo"), "a plain directory is its own identity");
});

test("only one session may poll a bot, and it is the oldest live claim", (t) => {
  isolated();
  t.after(() => release(SESSION));
  // Symphony runs a lead and its workers in one repository, each with its own telex
  // process. Both polling one token is how the same message got two receipts.
  const older = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    statePath(),
    JSON.stringify({ sessions: [{ ...alive({ session_id: OTHER, agent: "lead" }), started_at: older }] }),
  );

  touch(entry({ agent: "worker" }));

  assert.equal(ownerOf("work"), OTHER, "the lead claimed the bot first and keeps it");
  assert.notEqual(ownerOf("work"), SESSION, "the worker must not poll");
});

test("ownership moves on when the owner stops running", (t) => {
  isolated();
  t.after(() => release(SESSION));
  const older = new Date(Date.now() - 60_000).toISOString();
  // A pid nothing is running under: the previous owner is gone.
  writeFileSync(
    statePath(),
    JSON.stringify({ sessions: [{ ...alive({ session_id: OTHER, agent: "lead", pid: 2 ** 22 }), started_at: older }] }),
  );

  touch(entry({ agent: "worker" }));

  assert.equal(ownerOf("work"), SESSION, "a dead owner does not hold the bot");
});

test("a running owner keeps polling through a long gap between host hooks", (t) => {
  isolated();
  t.after(() => release(SESSION));
  const stale = alive({ session_id: OTHER, agent: "owner", project: "/code/other", repo: "/code/other" });
  stale.started_at = new Date(Date.now() - 600_000).toISOString();
  stale.last_seen = stale.started_at;
  writeFileSync(statePath(), JSON.stringify({ sessions: [stale] }));
  touch(entry({ agent: "asker" }));
  assert.equal(ownerOf("work"), OTHER, "sparse hooks do not create a second poller");
});

test("ownership is per bot", (t) => {
  isolated();
  t.after(() => release(SESSION));
  const older = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    statePath(),
    JSON.stringify({ sessions: [{ ...alive({ session_id: OTHER, bot: "other" }), started_at: older }] }),
  );

  touch(entry());

  assert.equal(ownerOf("work"), SESSION, "another bot's owner is irrelevant");
  assert.equal(ownerOf("nobody"), undefined, "a bot with no live session has no owner");
});
