import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexRpc, CodexRejection, deliveryMethod } from "../src/codex.ts";

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
