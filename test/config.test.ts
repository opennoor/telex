import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("server config resolves independent defaults and validates saved durations", () => {
  const path = join(mkdtempSync(join(tmpdir(), "telex-config-")), "config.json");
  process.env.TELEX_CONFIG = path;
  const config = { bots: { main: { token: "123:abc", chatId: 7 } } };
  writeFileSync(path, JSON.stringify(config));
  assert.equal(loadConfig().queueExpirySeconds, 3600);
  assert.equal(loadConfig().questionTimeoutSeconds, 600);

  writeFileSync(path, JSON.stringify({ ...config, queueExpirySeconds: 9000, questionTimeoutSeconds: 900 }));
  assert.equal(loadConfig().queueExpirySeconds, 9000);
  assert.equal(loadConfig().questionTimeoutSeconds, 900);

  writeFileSync(path, JSON.stringify({ ...config, queueExpirySeconds: "never" }));
  assert.throws(() => loadConfig(), /queueExpirySeconds must be an integer/);
  delete process.env.TELEX_CONFIG;
});
