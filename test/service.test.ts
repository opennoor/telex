import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceUnit } from "../src/service.ts";

test("service unit pins executable, config and state, and escapes systemd syntax", () => {
  process.env.TELEX_CONFIG = '/tmp/telex %h/$secret/"config.json';
  process.env.TELEX_STATE = "/tmp/telex-state/sessions.json";
  const unit = serviceUnit('/tmp/my %h/$tool/"cli.js');
  assert.ok(unit.includes('%%h/$$tool/\\"cli.js" daemon'));
  assert.ok(unit.includes('Environment="TELEX_CONFIG=/tmp/telex %%h/$secret/\\"config.json"'));
  assert.match(unit, /Environment="TELEX_STATE=\/tmp\/telex-state\/sessions.json"/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default.target/);
  assert.throws(() => serviceUnit("/tmp/invalid\ncli.js"), /newline/);
});

test("generated unit passes native systemd parser when available", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const unit = join(mkdtempSync(join(tmpdir(), "telex-unit-")), "telex.service");
  process.env.TELEX_CONFIG = "/tmp/config with %h spaces.json";
  process.env.TELEX_STATE = "/tmp/state with spaces/sessions.json";
  writeFileSync(unit, serviceUnit(resolve("dist/cli.js")));
  const result = spawnSync("systemd-analyze", ["--user", "verify", unit], { encoding: "utf8" });
  if ((result.error as NodeJS.ErrnoException)?.code === "ENOENT") { t.skip("systemd-analyze unavailable"); return; }
  assert.equal(result.status, 0, result.stderr);
});
