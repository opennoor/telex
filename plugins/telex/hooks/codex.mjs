#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const state = process.env.TELEX_STATE ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "telex", "sessions.json");

function request(path, input) {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let reply = "";
    socket.setTimeout(150, () => socket.destroy());
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
  const { hook_event_name: event, session_id: host_session_id, cwd: project_path,
    prompt, stop_hook_active } = JSON.parse(readFileSync(0, "utf8"));
  if (!["UserPromptSubmit", "PostToolUse", "Stop"].includes(event) ||
      typeof host_session_id !== "string" || typeof project_path !== "string") return;
  const input = { event, host_session_id, project_path, agent: "codex",
    ...(event === "UserPromptSubmit" && typeof prompt === "string" ? { prompt } : {}),
    ...(event === "Stop" ? { stop_hook_active: stop_hook_active === true || stop_hook_active === "true" } : {}) };
  for (const entry of readdirSync(dirname(state), { withFileTypes: true })) {
    if (!/^hook-\d+-[0-9a-f-]+\.sock$/.test(entry.name) || !entry.isSocket()) continue;
    const reply = await request(join(dirname(state), entry.name), input);
    if (reply?.accepted) {
      if (reply.output) process.stdout.write(`${JSON.stringify(reply.output)}\n`);
      return;
    }
  }
}

await main().catch(() => {});
