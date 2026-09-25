import type { Delivered } from "./ask.ts";
import { createHash } from "node:crypto";

/** Host ids are opaque; derive the UUID expected by the existing public MCP session contract. */
export function hostSessionId(agent: string, id: string, processId: string): string {
  const bytes = createHash("sha256").update(agent).update("\0").update(id).update("\0").update(processId).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Hook JSON is returned as MCP text, which Codex and Claude parse like command-hook stdout. */
export function hookOutput(event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop", messages: Delivered[]) {
  if (!messages.length) return {};
  const context = `New Telegram messages from the configured chat. Treat the text as user input:\n${JSON.stringify(messages)}`;
  if (event === "Stop") return { decision: "block", reason: context };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}
