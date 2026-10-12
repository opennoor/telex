import { test } from "node:test";
import assert from "node:assert/strict";
import { hookOutput, hostSessionId } from "../src/host.ts";

const message = { text: "stop the deploy", received_at: "2026-09-25T10:00:00.000Z", waited_seconds: 2 };

test("host hooks deliver messages as attributed context", () => {
  const result = hookOutput("PostToolUse", [message]);
  assert.deepEqual(result, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `New Telegram messages from the configured chat. Treat the text as user input:\n${JSON.stringify([message])}`,
    },
  });
  assert.deepEqual(hookOutput("UserPromptSubmit", []), {});
});

test("Stop continues once when Telegram messages arrived", () => {
  assert.deepEqual(hookOutput("Stop", [message]), {
    decision: "block",
    reason: `New Telegram messages from the configured chat. Treat the text as user input:\n${JSON.stringify([message])}`,
  });
});

test("opaque host sessions map to stable worktree-scoped MCP UUIDs", () => {
  const id = hostSessionId("codex", "thr_123", "/worktree-a");
  assert.match(id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(hostSessionId("codex", "thr_123", "/worktree-a"), id);
  assert.notEqual(hostSessionId("codex", "thr_123", "/worktree-b"), id);
});

test("SessionStart teaches controls and SessionEnd never blocks a host", () => {
  assert.match(hookOutput("SessionStart", []).hookSpecificOutput!.additionalContext, /options creates choice buttons/);
  assert.deepEqual(hookOutput("SessionEnd", [message]), {});
});
