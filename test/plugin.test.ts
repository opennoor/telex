import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(process.cwd(), "plugins/telex");

test("host plugins register one MCP server and one explicit hook file", () => {
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["telex"]);
  assert.equal(existsSync(join(root, "hooks/hooks.json")), false);

  for (const [host, server, agent, manifestPath] of [
    ["codex", "telex", "codex", ".codex-plugin/plugin.json"],
    ["claude", "plugin:telex:telex", "claude-code", ".claude-plugin/plugin.json"],
  ]) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    const hookPath = `./hooks/${host}.json`;
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.equal(manifest.hooks, hookPath);

    const config = JSON.parse(readFileSync(join(root, hookPath), "utf8"));
    assert.deepEqual(Object.keys(config.hooks).sort(), ["PostToolUse", "Stop", "UserPromptSubmit"]);
    for (const event of Object.keys(config.hooks)) {
      const [group] = config.hooks[event];
      assert.equal(group.hooks.length, 1);
      assert.deepEqual(group.hooks[0], {
        type: "mcp_tool",
        server,
        tool: "host_hook",
        input: {
          event,
          host_session_id: "${session_id}",
          project_path: "${cwd}",
          agent,
          ...(event === "Stop" ? { stop_hook_active: "${stop_hook_active}" } : {}),
        },
      });
    }
  }
});
