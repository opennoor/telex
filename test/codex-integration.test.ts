import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexStatePath, readCodexState } from "../src/codex.ts";
import { fileInbox, scopedInbox } from "../src/inbox.ts";
import { fileRoutes } from "../src/routes.ts";
import { touch, release } from "../src/registry.ts";
import { BotSession } from "../src/telegram.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await pause(30);
  assert.ok(check(), "expected mocked bridge activity did not occur");
}
function records(path: string): any[] {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}
function exited(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null) return child.exitCode ? reject(new Error(`child exited ${child.exitCode}`)) : resolve();
    child.once("error", reject);
    child.once("exit", (code) => code ? reject(new Error(`child exited ${code}`)) : resolve());
  });
}

test("managed worktrees share a bot while replies, resumed routes, recovery and lifecycle stay isolated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "telex-managed-"));
  const previous = { ...process.env };
  const children: ChildProcess[] = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    for (const key of ["TELEX_STATE", "TELEX_CONFIG", "TELEX_INBOX", "TELEX_PROJECT_CONFIG", "TELEX_BOT"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
  process.env.TELEX_STATE = join(root, "sessions.json");
  process.env.TELEX_INBOX = join(root, "inbox.json");
  process.env.TELEX_CONFIG = join(root, "config.json");
  process.env.TELEX_PROJECT_CONFIG = join(root, "project.json");
  delete process.env.TELEX_BOT;
  writeFileSync(process.env.TELEX_CONFIG, JSON.stringify({ defaultBot: "work", bots: { work: { token: "fake-token", chatId: 7, allowFrom: [42] } } }));
  writeFileSync(process.env.TELEX_PROJECT_CONFIG, JSON.stringify({ bot: "work" }));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  const git = (...args: string[]) => execFileSync("git", ["-C", first, ...args], { stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
  writeFileSync(join(first, "file"), "fixture"); git("add", "."); git("commit", "-qm", "fixture");
  git("worktree", "add", "-qb", "second-branch", second);
  const bin = join(root, "bin"); mkdirSync(bin);
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const log=x=>fs.appendFileSync(process.env.RPC_LOG,JSON.stringify(x)+'\\n');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let active=false,turnId='turn-'+process.env.THREAD_ID;
const finish=()=>{if(!active)return;active=false;
 send({method:'item/completed',params:{threadId:'wrong-thread',turnId,item:{type:'agentMessage',text:'must-not-forward'}}});
 send({method:'item/completed',params:{threadId:process.env.THREAD_ID,turnId,item:{type:'agentMessage',text:'final-'+process.env.THREAD_ID}}});
 send({method:'turn/completed',params:{threadId:process.env.THREAD_ID,turn:{id:turnId}}});};
log({launch:process.argv.slice(2),state:process.env.TELEX_CODEX_STATE});
rl.on('line',line=>{const m=JSON.parse(line);log(m);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='initialized')send({id:7000,method:'item/commandExecution/requestApproval',params:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:m.params.threadId||process.env.THREAD_ID}}});
 if(m.method==='thread/read')send({id:m.id,result:{thread:{status:{type:active?'active':'idle'}}}});
 if(m.method==='turn/start'){active=true;send({id:m.id,result:{turn:{id:turnId}}});send({method:'turn/started',params:{threadId:process.env.THREAD_ID,turn:{id:turnId}}});setTimeout(finish,2200);}
 if(m.method==='turn/steer'){send({id:m.id,result:{turnId}});setTimeout(finish,10);}
});
`);
  chmodSync(executable, 0o700);
  const runner = join(root, "runner.mjs");
  const module = new URL("../src/codex.js", import.meta.url).href;
  writeFileSync(runner, `import fs from 'node:fs';import {runCodex,recoverCodex} from ${JSON.stringify(module)};
let messageId=Number(process.env.MESSAGE_BASE);
globalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1),params=JSON.parse(options.body);fs.appendFileSync(process.env.API_LOG,JSON.stringify({method,params})+'\\n');
 if(method==='getUpdates')await new Promise(r=>setTimeout(r,50));
 if(process.env.FAIL_FINAL==='1'&&method==='sendMessage'&&params.text.includes('final-'))return {json:async()=>({ok:false,description:'send failed'})};
 return {json:async()=>({ok:true,result:method==='getUpdates'?[]:method==='sendMessage'?{message_id:++messageId}:true})};};
if(process.env.RECOVER_ID)await recoverCodex(Number(process.env.RECOVER_ID),true);else await runCodex();
`);
  const hash = createHash("sha256").update("fake-token").digest("hex");
  touch({ session_id: "fixture-daemon", bot: hash, project: root, repo: root, agent: "telex-daemon", pid: process.pid, interval_seconds: 5 });
  t.after(() => release("fixture-daemon"));
  const launch = (project: string, threadId: string, base: number, extra: Record<string, string> = {}) => {
    const suffix = `${threadId}-${children.length}`;
    const rpcLog = join(root, `${suffix}.rpc`), apiLog = join(root, `${suffix}.api`), errors = join(root, `${suffix}.errors`);
    const child = spawn(process.execPath, [runner], { cwd: project, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, THREAD_ID: threadId, MESSAGE_BASE: String(base), RPC_LOG: rpcLog, API_LOG: apiLog, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stderr!.on("data", (data) => appendFileSync(errors, data));
    return { child, rpcLog, apiLog, errors };
  };
  const one = launch(first, "one", 1000);
  const two = launch(second, "two", 2000, { FAIL_FINAL: "1" });
  const pathOne = codexStatePath(first, hash), pathTwo = codexStatePath(second, hash);
  assert.notEqual(pathOne, pathTwo);
  await until(() => Boolean(readCodexState(pathOne)?.routeId && readCodexState(pathTwo)?.routeId));
  const stateOne = readCodexState(pathOne)!, stateTwo = readCodexState(pathTwo)!;
  assert.notEqual(stateOne.routeId, stateTwo.routeId);
  await until(() => records(one.apiLog).some((c) => c.params.text?.includes("session started")) && records(two.apiLog).some((c) => c.params.text?.includes("session started")));
  assert.ok(records(one.rpcLog).find((m) => m.method === "thread/start").params.developerInstructions.includes("expect_text"));
  assert.ok(records(one.rpcLog)[0].launch.some((arg: string) => arg.startsWith("mcp_servers.telex.command=")));
  assert.equal(records(one.rpcLog)[0].state, pathOne);
  assert.equal(records(one.rpcLog).find((m) => m.id === 7000)?.result.decision, "decline");
  assert.equal(records(one.apiLog).filter((c) => c.method === "getUpdates").length, 0);
  const store = fileInbox();
  const central = () => {
    const listener = new BotSession(async () => true);
    listener.setRouteStore(fileRoutes("fake-token"), (route, incoming) => scopedInbox(store, `${hash}:${route.id}`).push(String(route.chatId), incoming));
    return listener;
  };
  let listener = central();
  const firstMessage = records(one.apiLog).find((c) => c.method === "sendMessage")!;
  assert.match(firstMessage.params.text, /codex/);
  const send = (id: number, reply: number, text: string, fromId = 42) => listener.dispatch({ update_id: id, message: { message_id: id, text, chat: { id: 7 }, from: { id: fromId }, reply_to_message: { message_id: reply } } });
  send(1, 1001, "first payload");
  send(2, 2001, "second payload");
  send(3, 1001, "intruder payload", 99);
  await until(() => records(one.rpcLog).some((m) => m.method === "turn/start") && records(two.rpcLog).some((m) => m.method === "turn/start"));
  listener = central(); // A restarted listener uses only durable message-to-route ownership.
  send(4, 1001, "steer first");
  await until(() => records(one.rpcLog).some((m) => m.method === "turn/steer"));
  assert.equal(records(two.rpcLog).filter((m) => m.method === "turn/steer").length, 0);
  const firstInputs = records(one.rpcLog).filter((m) => /^turn\/(?:start|steer)$/.test(m.method)).map((m) => m.params.input[0].text).join("\n");
  assert.match(firstInputs, /first payload/); assert.match(firstInputs, /steer first/);
  assert.doesNotMatch(firstInputs, /second payload|intruder/);
  assert.match(records(two.rpcLog).find((m) => m.method === "turn/start").params.input[0].text, /second payload/);
  await until(() => records(one.apiLog).some((c) => c.params.text?.includes("final-one")) && readCodexState(pathTwo)?.outbox?.some((item) => item.text === "final-two") === true);
  assert.equal(records(one.apiLog).some((c) => c.params.text?.includes("must-not-forward")), false);
  const finalOne = records(one.apiLog).find((c) => c.params.text?.includes("final-one"))!.params.text;
  assert.match(finalOne, /final-one/);
  assert.match(finalOne, /↳ branch .* · worktree/);
  one.child.kill("SIGTERM"); two.child.kill("SIGTERM");
  await Promise.all([exited(one.child), exited(two.child)]);
  assert.equal(readCodexState(pathOne)?.pid, undefined);
  assert.equal(fileRoutes("fake-token").get(stateOne.routeId!), undefined);
  assert.equal(fileRoutes("fake-token").get(stateTwo.routeId!), undefined);
  assert.ok(records(one.apiLog).some((c) => c.params.text?.includes("session ended")));
  const recovered = launch(second, "recover", 3000, { RECOVER_ID: "2" });
  await exited(recovered.child);
  const recoveredMessage = records(recovered.apiLog).find((c) => c.params.text?.includes("final-two"));
  assert.match(recoveredMessage?.params.text ?? "", /final-two/);
  assert.match(recoveredMessage?.params.text ?? "", /↳ branch .* · worktree/);
  assert.equal(readCodexState(pathTwo)?.outbox?.length, 0);
  assert.equal(fileRoutes("fake-token").get(stateTwo.routeId!), undefined, "recovery CLI is not an active destination");
  const firstQueue = scopedInbox(store, `${hash}:${stateOne.routeId}`);
  const secondQueue = scopedInbox(store, `${hash}:${stateTwo.routeId}`);
  firstQueue.push("7", { message_id: 50, text: "uncertain first", received_at: Date.now(), receipt_id: 1050 });
  secondQueue.push("7", { message_id: 51, text: "uncertain second", received_at: Date.now() });
  firstQueue.claim("7", "codex:uncertain-one", () => true);
  secondQueue.claim("7", "codex:uncertain-two", () => true);
  const retry = launch(first, "retry", 3500, { RECOVER_ID: "50" });
  await exited(retry.child);
  assert.deepEqual(firstQueue.take("7").map((message) => message.text), ["uncertain first"]);
  assert.equal(secondQueue.claimed("7")[0].message_id, 51, "other thread's uncertain delivery is untouched");
  const retryEdit = records(retry.apiLog).find((call) => call.method === "editMessageText")!.params.text;
  assert.match(retryEdit, /Held for the agent.s next check-in/);
  assert.match(retryEdit, /↳ branch .* · worktree/);
  const resumed = launch(first, "one", 4000);
  await until(() => records(resumed.rpcLog).some((m) => m.method === "thread/resume") && Boolean(fileRoutes("fake-token").get(stateOne.routeId!)));
  assert.equal(readCodexState(pathOne)?.routeId, stateOne.routeId);
  assert.equal([...records(one.apiLog), ...records(resumed.apiLog)].filter((call) => call.params.text?.includes("session started")).length, 1,
    "resuming the same root thread does not create another start notification");
  listener = central();
  send(5, 1001, "reply after bridge restart");
  await until(() => records(resumed.rpcLog).some((m) => m.method === "turn/start"));
  assert.match(records(resumed.rpcLog).find((m) => m.method === "turn/start").params.input[0].text, /reply after bridge restart/);
  resumed.child.kill("SIGTERM"); await exited(resumed.child);
  assert.equal([...records(one.apiLog), ...records(resumed.apiLog)].filter((call) => call.params.text?.includes("session ended")).length, 1,
    "the resumed root thread keeps exactly one end notification");
});
