import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpc, CodexRejection, deliveryMethod, codexStatePath, codexStatus, pendingCodex, recoverCodex } from "../src/codex.ts";

test("Codex RPC handshakes, declines host approvals, and handles explicit rejection", async () => {
  const fake = `
    const rl=require('node:readline').createInterface({input:process.stdin});
    rl.on('line', line => {
      const m=JSON.parse(line);
      const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
      if(m.method==='initialize') send({id:m.id,result:{}});
      if(m.method==='initialized') {
        send({id:99,method:'item/commandExecution/requestApproval',params:{}});
        send({id:98,method:'item/permissions/requestApproval',params:{}});
      }
      if(m.id===99) send({method:'approval/observed',params:{decision:m.result?.decision}});
      if(m.id===98) send({method:'permissions/observed',params:{code:m.error?.code}});
      if(m.method==='thread/read') send({id:m.id,result:{thread:{status:{type:'idle'}}}});
      if(m.method==='turn/steer') send({id:m.id,error:{code:-32602,message:'wrong turn'}});
    });
  `;
  const rpc = new CodexRpc(process.execPath, ["-e", fake]);
  try {
    const observed = new Promise<string>((resolve) => { rpc.onEvent = (m) => {
      if (m.method === "approval/observed") resolve(m.params.decision);
    }; });
    const permissions = new Promise<number>((resolve) => { const previous = rpc.onEvent; rpc.onEvent = (m) => {
      previous?.(m);
      if (m.method === "permissions/observed") resolve(m.params.code);
    }; });
    await rpc.initialize();
    assert.equal(await observed, "decline");
    assert.equal(await permissions, -32000);
    assert.equal((await rpc.request("thread/read")).thread.status.type, "idle");
    await assert.rejects(rpc.request("turn/steer"), CodexRejection);
  } finally { rpc.stop(); }
});

test("Codex delivery uses idle start and active steer only with a known turn", () => {
  assert.equal(deliveryMethod("idle"), "turn/start");
  assert.equal(deliveryMethod("active", "turn-1"), "turn/steer");
  assert.throws(() => deliveryMethod("active"));
  assert.throws(() => deliveryMethod("notLoaded"));
});


test("legacy and mismatched Codex state fails closed before recovery can send or drain", async (t) => {
  const project = mkdtempSync(join(tmpdir(), "telex-codex-binding-"));
  const cwd = process.cwd();
  const previous = { ...process.env };
  t.after(() => {
    process.chdir(cwd);
    for (const key of ["TELEX_STATE", "TELEX_CONFIG", "TELEX_PROJECT_CONFIG", "TELEX_BOT"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
  process.chdir(project);
  process.env.TELEX_STATE = join(project, "sessions.json");
  process.env.TELEX_CONFIG = join(project, "config.json");
  process.env.TELEX_PROJECT_CONFIG = join(project, "project.json");
  delete process.env.TELEX_BOT;
  writeFileSync(process.env.TELEX_CONFIG, JSON.stringify({ defaultBot: "work", bots: { work: { token: "test-token", chatId: 7, allowFrom: [42] } } }));
  writeFileSync(process.env.TELEX_PROJECT_CONFIG, JSON.stringify({ bot: "work" }));
  const bot = createHash("sha256").update("test-token").digest("hex");
  const path = codexStatePath(project, bot);
  const legacy = { threadId: "original", project, bot, outbox: [{ turnId: "uncertain", text: "saved answer", messages: [{ message_id: 1, text: "question", received_at: Date.now() }] }] };
  writeFileSync(path, JSON.stringify(legacy));
  assert.equal(codexStatus().state?.threadId, "original");
  assert.throws(() => pendingCodex(), /no isolated route/);
  await assert.rejects(recoverCodex(1, true), /no isolated route/);
  for (const mismatch of [{ chatId: 8 }, { bot: "wrong-token-hash" }, { project: join(project, "other") }]) {
    writeFileSync(path, JSON.stringify({ ...legacy, ...mismatch }));
    assert.throws(() => codexStatus(), /binding differs/);
    await assert.rejects(recoverCodex(1, true), /binding differs/);
  }
  writeFileSync(path, JSON.stringify({ ...legacy, chatId: 7, routeId: "another-thread", route: { id: "another-thread", chatId: 7, worktree: project } }));
  assert.throws(() => pendingCodex(), /no isolated route/);
  await assert.rejects(recoverCodex(1, true), /no isolated route/);
});
