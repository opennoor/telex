#!/usr/bin/env node
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const state = process.env.TELEX_STATE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "telex", "sessions.json");
const agent = process.argv[2] === "claude-code" ? "claude-code" : "codex";
const controls = "Telex Telegram controls: send_to_user options creates choice buttons; expect_text creates a Reply button; omit both for a one-way notification. Replies return to the exact session. Unsolicited messages with multiple sessions show a session selector. Use heartbeat during long stretches between host hooks; acknowledge Claude channel delivery_id with ack_channel_message after reading. Stop ends a turn, not the session.";
function ancestors(pid) {
  const result = [];
  while (pid > 1 && !result.includes(pid)) {
    result.push(pid);
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); }
    catch { break; }
  }
  return result;
}
function start(pid) {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; }
  catch { return undefined; }
}
function request(path, input) {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let reply = "";
    socket.setTimeout(input.event === "SessionEnd" ? 1000 : 300, () => socket.destroy());
    socket.on("connect", () => socket.write(`${JSON.stringify(input)}\n`));
    socket.on("data", (chunk) => {
      reply += chunk;
      if (reply.length > 4 * 1024 * 1024) return socket.destroy();
      const end = reply.indexOf("\n");
      if (end < 0) return;
      try { resolve(JSON.parse(reply.slice(0, end))); } catch { resolve(null); }
      socket.destroy();
    });
    socket.on("error", () => resolve(null));
    socket.on("close", () => resolve(null));
  });
}
async function main() {
  if (process.env.TELEX_CODEX_BRIDGE === "1") return;
  const { hook_event_name: event, session_id: host_session_id, cwd: project_path, prompt, stop_hook_active } = JSON.parse(readFileSync(0, "utf8"));
  if (!["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "Stop"].includes(event) || typeof host_session_id !== "string" || typeof project_path !== "string") return;
  const chain = ancestors(process.pid);
  const hostPid = chain.find((pid) => {
    try { return /^(codex|claude)(?:-code)?$/.test(readFileSync(`/proc/${pid}/comm`, "utf8").trim()); }
    catch { return false; }
  });
  const input = { event, host_session_id, project_path, agent,
    ...(event === "UserPromptSubmit" && typeof prompt === "string" ? { prompt } : {}),
    ...(event === "Stop" ? { stop_hook_active: stop_hook_active === true || stop_hook_active === "true" } : {}) };
  // SessionStart may precede MCP startup. Only its exact live host ancestor may consume this spool.
  const spool = hostPid && join(dirname(state), `hook-start-${createHash("sha256").update(`${agent}:${hostPid}`).digest("hex")}.json`);
  if (event === "SessionStart" && spool) {
    mkdirSync(dirname(state), { recursive: true, mode: 0o700 });
    const tmp = `${spool}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...input, hostPid, hostStart: start(hostPid), at: Date.now() }), { mode: 0o600 });
    renameSync(tmp, spool);
  }
  const candidates = [];
  let entries = [];
  try { entries = readdirSync(dirname(state), { withFileTypes: true }); } catch { /* no MCP yet */ }
  for (const entry of entries) {
    if (!/^hook-\d+-[0-9a-f-]+\.sock$/.test(entry.name) || !entry.isSocket()) continue;
    const path = join(dirname(state), entry.name);
    const probe = await request(path, { ...input, probe: true });
    if (!probe?.eligible) continue;
    if (hostPid && !probe.ancestors?.includes(hostPid)) continue;
    const score = probe.bound ? -1 : Math.min(...(probe.ancestors ?? []).map((pid, i) => chain.includes(pid) ? i + chain.indexOf(pid) : Infinity));
    candidates.push({ path, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  // A tie is ambiguous: leave messages queued instead of binding the wrong conversation.
  if (candidates.length && (candidates.length === 1 || candidates[0].score < candidates[1].score)) {
    const reply = await request(candidates[0].path, input);
    if (reply?.accepted) {
      if (event === "SessionEnd" && spool) rmSync(spool, { force: true });
      if (reply.output) process.stdout.write(`${JSON.stringify(reply.output)}\n`);
      return;
    }
  }
  if (event === "SessionStart") process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: controls } })}\n`);
}
await main().catch(() => {});
