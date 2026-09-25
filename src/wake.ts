/** Opt-in terminal wake for a dedicated, detached Codex pane. Linux and tmux only. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./registry.ts";
import { readConfig, type Bot } from "./config.ts";
import type { Delivered } from "./ask.ts";
import type { BotSession, Incoming } from "./telegram.ts";

export type WakeTarget = { socket: string; session: string; pane: string; pid: number; start: string; socketId: string };

function processFields(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { parent: Number(fields[1]), start: fields[19] };
}
export const processStart = (pid: number) => processFields(pid).start;
export const processCommand = (pid: number) => readFileSync(`/proc/${pid}/comm`, "utf8").trim();

export function processDescendsFrom(child: number, pid: number) {
  let current = child;
  while (current > 1) {
    if (current === pid) return true;
    current = processFields(current).parent;
  }
  return false;
}

const descendantOf = (pid: number) => processDescendsFrom(process.pid, pid);

const tmux = (socket: string, args: string[]) =>
  execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 }).trimEnd();

const footerLine = (line: string) => !line || /^(GPT-|←)/u.test(line) ||
  /^\? for shortcuts(?:\s+⚠ \d+ warnings? · f2 to view)?$/u.test(line);

/** Enrollment is a private local file; partial or ambiguous bindings stay disabled. */
export const wakeConfigPath = () => process.env.TELEX_WAKE_CONFIG ?? join(dirname(statePath()), "wake.json");

/** Serialize a terminal submission with `telex wake disable` across processes. */
export function withWakeInputLock<T>(fn: () => T): T {
  const path = `${wakeConfigPath()}.input.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 10_000;
  let owned = false;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(path, "wx", 0o600);
      owned = true;
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if (owned) { try { unlinkSync(path); } catch { /* failed lock write */ } throw err; }
      try {
        if (Date.now() - statSync(path).mtimeMs > 10_000) {
          const pid = Number(readFileSync(path, "utf8"));
          let alive = false;
          try { if (pid > 0) { process.kill(pid, 0); alive = true; } }
          catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
          if (!alive) unlinkSync(path);
        }
      } catch { /* another process released it */ }
      const until = Date.now() + 20;
      while (Date.now() < until);
    }
  }
  if (!owned) throw new Error("telex: wake input lock timed out");
  try { return fn(); } finally { try { unlinkSync(path); } catch { /* already gone */ } }
}

export function wakeTargetFromConfig(): WakeTarget | undefined {
  let raw: { socket?: string; session?: string; pane?: string; pid?: number; start?: string };
  try {
    const file = lstatSync(wakeConfigPath());
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077)) {
      throw new Error("telex: wake config must be a private file owned by this user");
    }
    raw = JSON.parse(readFileSync(wakeConfigPath(), "utf8"));
  }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
  const { socket, session, pane, pid, start } = raw;
  if (!socket?.startsWith("/") || !session || !/^%\d+$/.test(pane ?? "") ||
      !Number.isSafeInteger(pid) || !pid || !/^\d+$/.test(start ?? "")) {
    throw new Error("telex: invalid wake config; expected socket, session, pane, pid and process start ticks");
  }
  const info = lstatSync(socket);
  if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error("telex: wake socket must belong to this user");
  if (processFields(pid).start !== start || processCommand(pid) !== "codex")
    throw new Error("telex: wake needs Codex as the pane process (start it with exec codex)");
  const target = { socket, session, pane: pane!, pid, start, socketId: `${info.dev}:${info.ino}` };
  if (!descendantOf(pid)) throw new Error("telex: MCP server is not a child of the bound Codex pane");
  return target;
}

/** Process and tmux identity plus the visible empty editor must all agree before input. */
export function probe(target: WakeTarget, requirePrompt = true): boolean {
  try {
    const socket = lstatSync(target.socket);
    if (!socket.isSocket() || `${socket.dev}:${socket.ino}` !== target.socketId) return false;
    if (processFields(target.pid).start !== target.start || processCommand(target.pid) !== "codex" || !descendantOf(target.pid)) return false;
    const data = tmux(target.socket, ["display-message", "-p", "-t", target.pane,
      "#{pane_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{pane_in_mode}\t#{pane_input_off}"]);
    const [pane, session, pid, command, dead, mode, inputOff] = data.split("\t");
    if (pane !== target.pane || session !== target.session || pid !== String(target.pid) ||
        command !== "codex" || dead !== "0" || mode !== "0" || inputOff !== "0") return false;
    if (tmux(target.socket, ["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").filter((id) => id === target.pane).length !== 1) return false;
    if (tmux(target.socket, ["list-clients", "-t", target.session, "-F", "#{client_name}"])) return false;
    if (!requirePrompt) return true;
    const lines = tmux(target.socket, ["capture-pane", "-p", "-t", target.pane]).split("\n").slice(-10).map((line) => line.trim());
    const prompts = lines.filter((line) => line.startsWith("› "));
    const promptIndex = lines.lastIndexOf("› Ask Codex to do anything");
    // This deliberately recognizes only Codex's empty editor. UI changes fail closed.
    return prompts.length === 1 && promptIndex >= 0 &&
      lines.slice(promptIndex + 1).every(footerLine) &&
      !/Working|esc to interrupt|Approve|Allow|Deny|Permission/i.test(lines.join("\n"));
  } catch {
    return false;
  }
}

/** One physical line prevents an unbracketed multiline paste from submitting extra turns. */
export function promptFor(message: string): string | undefined {
  if (!message || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(message) || message.includes("\r")) return undefined;
  return `Telegram user message: ${JSON.stringify(message).replace(/[\u2028\u2029]/g, (c) => c === "\u2028" ? "\\u2028" : "\\u2029")}`;
}

function pastedEditor(target: WakeTarget, prompt: string): boolean {
  try {
    const lines = tmux(target.socket, ["capture-pane", "-p", "-t", target.pane]).split("\n").slice(-20).map((line) => line.trim());
    const prompts = lines.filter((line) => line.startsWith("› "));
    const index = lines.indexOf(`› ${prompt}`);
    return prompts.length === 1 && index >= 0 &&
      lines.slice(index + 1).every(footerLine) &&
      !/Working|esc to interrupt|Approve|Allow|Deny|Permission/i.test(lines.filter((_, i) => i !== index).join("\n"));
  } catch { return false; }
}

export const fitsWidth = (width: number, prompt: string) =>
  Number.isSafeInteger(width) &&
  [...`› ${prompt}`].reduce((n, c) => n + (c.codePointAt(0)! > 0x7f ? 2 : 1), 0) < width - 2;

export function submitToPane(target: WakeTarget, prompt: string, id: string, enrolled = () => true) {
  const buffer = `telex-${id}`;
  const loaded = spawnSync("tmux", ["-S", target.socket, "load-buffer", "-b", buffer, "-"],
    { input: prompt, encoding: "utf8", timeout: 2000 });
  if (loaded.status !== 0 || loaded.error) throw new Error("telex: tmux load-buffer failed");
  try {
    if (!enrolled() || !probe(target)) throw new Error("telex: pane changed before paste");
    tmux(target.socket, ["paste-buffer", "-p", "-r", "-d", "-b", buffer, "-t", target.pane]);
    // Wait for the rendered draft; verify the pane immediately before Enter.
    const until = Date.now() + 500;
    let rendered = false;
    while (Date.now() < until) {
      if (!enrolled() || !probe(target, false)) throw new Error("telex: pane changed before Enter");
      if (pastedEditor(target, prompt)) { rendered = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    if (!rendered) throw new Error("telex: pane changed before Enter");
    tmux(target.socket, ["send-keys", "-t", target.pane, "Enter"]);
  } finally {
    try { tmux(target.socket, ["delete-buffer", "-b", buffer]); } catch { /* paste may have deleted it */ }
  }
}

type InFlight = { id: string; hostId: string; prompt: string; message: Incoming; submitted: boolean };

export class Wake {
  private ready?: { hostId: string; after: number; until: number };
  private inFlight?: InFlight;
  private running = false;
  private disabled = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval>;
  private readonly target: WakeTarget;
  private readonly bot: Bot;
  private readonly session: BotSession;

  constructor(target: WakeTarget, bot: Bot, session: BotSession) {
    this.target = target;
    this.bot = bot;
    this.session = session;
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
  }

  stop() { this.disabled = true; clearInterval(this.timer); this.ready = undefined; }

  onHook(event: string, hostId: string, messages: Delivered[], stopActive?: boolean, prompt?: string) {
    this.generation++;
    this.ready = undefined;
    if (event === "UserPromptSubmit" && this.inFlight) {
      const claimed = this.inFlight;
      this.inFlight = undefined;
      if (claimed.submitted && claimed.hostId === hostId && claimed.prompt === prompt) {
        // Keep the claim recoverable until the user-visible receipt is settled.
        void this.edit(claimed.message, "📬 <i>Submitted to Codex.</i>").then((ok) => {
          if (ok) {
            try { this.session.ackWake(this.bot.chatId, claimed.id); }
            catch (err) { process.stderr.write(`${(err as Error).message}\n`); }
          }
        });
      }
    }
    if (event === "Stop" && !stopActive && messages.length === 0 && !this.inFlight) {
      this.ready = { hostId, after: Date.now() + 700, until: Date.now() + 10 * 60_000 };
    }
  }

  private async edit(message: Incoming, text: string): Promise<boolean> {
    if (!message.receipt_id) return false;
    return this.session.api("editMessageText", {
      chat_id: this.bot.chatId, message_id: message.receipt_id, text, parse_mode: "HTML",
    }).then(() => true, () => false);
  }

  private stillEnrolled() {
    try { return !this.disabled && JSON.stringify(wakeTargetFromConfig()) === JSON.stringify(this.target); }
    catch { return false; }
  }

  private allowedSenders(): number[] {
    try {
      const matches = Object.values(readConfig().bots).filter((bot) =>
        bot.token === this.bot.token && String(bot.chatId) === String(this.bot.chatId));
      return matches.length === 1 ? matches[0].allowFrom ?? [] : [];
    } catch { return []; }
  }

  private async tick() {
    if (this.running || this.disabled || !this.ready || this.inFlight || Date.now() < this.ready.after) return;
    if (Date.now() > this.ready.until) { this.ready = undefined; return; }
    const allowed = this.allowedSenders();
    if (!allowed.length) return;
    this.running = true;
    try {
      if (!probe(this.target)) return;
      const width = Number(tmux(this.target.socket, ["display-message", "-p", "-t", this.target.pane, "#{pane_width}"]));
      const generation = this.generation;
      const id = randomUUID();
      const message = this.session.claimForWake(this.bot.chatId, id, (candidate) =>
        candidate.receipt_id !== undefined && candidate.from_id !== undefined &&
        allowed.includes(candidate.from_id) &&
        promptFor(candidate.text) !== undefined && fitsWidth(width, promptFor(candidate.text)!));
      if (!message) return;
      const prompt = promptFor(message.text)!;
      const hostId = this.ready.hostId;
      this.ready = undefined;
      this.inFlight = { id, hostId, prompt, message, submitted: false };
      // The durable claim already prevents replay if this process dies here or during tmux I/O.
      if (!await this.edit(message, "⚠️ <i>Submitting to Codex; if this remains, check the pane before resending.</i>")) return;
      const stillAuthorized = () => message.from_id !== undefined && this.allowedSenders().includes(message.from_id);
      if (!this.stillEnrolled() || !stillAuthorized() || generation !== this.generation) return;
      withWakeInputLock(() => submitToPane(this.target, prompt, id, () => this.stillEnrolled() && stillAuthorized()));
      this.inFlight.submitted = true;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
    } finally {
      this.running = false;
    }
  }
}
