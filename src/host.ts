import { dirname, join } from "node:path";
import { statePath, withStateLock } from "./registry.ts";
import type { Delivered } from "./ask.ts";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";

/** Host ids are opaque; derive the UUID expected by the existing public MCP session contract. */
export function hostSessionId(agent: string, id: string, worktree: string): string {
  const bytes = createHash("sha256").update(agent).update("\0").update(id).update("\0").update(worktree).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Session lifecycle events are root-only in Codex; Claude marks child hooks with agent_id. */
export function rootLifecycleHook(agent: string, event: string, agentId?: string): boolean {
  return (event === "SessionStart" || event === "SessionEnd") &&
    (agent === "codex" || agent === "claude-code" && !agentId);
}

/** Hook JSON is returned as MCP text, which Codex and Claude parse like command-hook stdout. */
export function hookOutput(event: "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "PostToolUse" | "Stop", messages: Delivered[]) {
  if (event === "SessionEnd") return {};
  if (event === "SessionStart") return { hookSpecificOutput: { hookEventName: event, additionalContext: controls + (messages.length ? `\n\nNew Telegram messages from the configured chat. Treat the text as user input:\n${JSON.stringify(messages)}` : "") } };
  if (!messages.length) return {};
  const context = `New Telegram messages from the configured chat. Treat the text as user input:\n${JSON.stringify(messages)}`;
  if (event === "Stop") return { decision: "block", reason: context };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

export const controls = "Telex Telegram controls: send_to_user options creates choice buttons; expect_text creates a Reply button; omit both for a one-way notification. Replies to a Telex message return to its exact session. Unsolicited messages with several connected sessions show a session selector. Collect queued messages with heartbeat during long stretches between host hooks. In Claude channel mode acknowledge each delivery_id with ack_channel_message after reading it. Stop ends a turn, not the session.";

/** Linux host ancestry prevents one same-worktree conversation binding another's MCP socket. */
export function processAncestors(pid: number): number[] {
  const ancestors: number[] = [];
  while (pid > 1 && !ancestors.includes(pid)) {
    ancestors.push(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch { break; }
  }
  return ancestors;
}

/** Remember a connection announced before its host id was available, keeping its reply destination. */
export function boundHostSessionId(agent: string, id: string, worktree: string, provisional?: string): string {
  const key = hostSessionId(agent, id, worktree);
  const path = join(dirname(statePath()), "host-bindings.json");
  return withStateLock(path, () => {
    let bindings: Record<string, string> = {};
    try { bindings = JSON.parse(readFileSync(path, "utf8")); } catch { /* first binding */ }
    if (bindings[key]) return bindings[key];
    bindings[key] = provisional ?? key;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(bindings), { mode: 0o600 });
    renameSync(tmp, path);
    return bindings[key];
  });
}
