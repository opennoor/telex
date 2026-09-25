/**
 * Which agents are alive, on disk, so separate telex processes can see each other.
 * Each project's agent runs its own server; only a shared file can tell them apart.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Session = {
  /** Identifies one agent session across calls, whatever it calls itself on any given one. */
  session_id: string;
  bot: string;
  project: string;
  /** The repository all of a project's worktrees share. Two worktrees are one project, not two. */
  repo: string;
  agent: string;
  pid: number;
  interval_seconds: number;
  started_at: string;
  last_seen: string;
};

const repoCache = new Map<string, string>();

/**
 * The identity a project keeps across its worktrees: every worktree of a repository reports the
 * same common git directory, so agents working in two of them are not two projects.
 */
export function repoOf(projectPath: string): string {
  const cached = repoCache.get(projectPath);
  if (cached) return cached;
  let repo = resolve(projectPath);
  try {
    const common = execFileSync("git", ["-C", projectPath, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // /repo/.git for the main worktree and every linked worktree alike; bare repos report themselves.
    if (common) repo = common.endsWith("/.git") ? dirname(common) : common;
  } catch {
    // Not a repository, or no git — the path is its own identity.
  }
  repoCache.set(projectPath, repo);
  return repo;
}

export const statePath = () =>
  process.env.TELEX_STATE ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "telex", "sessions.json");

const read = (): Session[] => {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return []; // a missing or corrupt file just means nothing is registered
  }
};

/** Read-only registrations for a CLI preflight; the wake runtime verifies identity again. */
export const registeredSessions = (): Session[] => read();

const write = (sessions: Session[]) => {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  // ponytail: write-rename, no lock. Two agents registering in the same millisecond can lose one
  // record; it reappears on that agent's next call. Use a lockfile if that ever matters.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ sessions }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
};

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A session counts as alive while its process exists and it has checked in within three intervals. */
export function isLive(session: Session, now: number) {
  const grace = Math.max(session.interval_seconds * 3, 60) * 1000;
  return running(session.pid) && now - Date.parse(session.last_seen) <= grace;
}

export type Registration = Omit<Session, "started_at" | "last_seen" | "repo"> & { repo?: string };

/**
 * Record this agent and return the other live agents that would fight it for the same bot.
 * Two pollers on one token split the updates between them, so the caller warns about these.
 * A session is matched by its id, not by name or pid: one session may call itself different
 * things on different calls, and telex must not read that as a second agent.
 */
export function touch(entry: Registration, now = Date.now()): Session[] {
  const stamp = new Date(now).toISOString();
  const repo = entry.repo ?? repoOf(entry.project);
  const existing = read();
  // Polling stays with a running server even while the host has no hook events to report.
  const others = existing.filter((s) => s.session_id !== entry.session_id && running(s.pid));
  const mine = existing.find((s) => s.session_id === entry.session_id);
  write([...others, { ...entry, repo, started_at: mine?.started_at ?? stamp, last_seen: stamp }]);
  // Worktrees of one repository are one project sharing one bot deliberately; that is not a clash.
  return others.filter((s) => isLive(s, now) && s.bot === entry.bot && s.repo !== repo);
}

/**
 * The one session allowed to poll a bot.
 *
 * Telegram serves an update to whoever asks, and confirms it only when that asker comes back with
 * a higher offset, so two pollers on one token either lose messages or acknowledge the same one
 * twice. Symphony runs a lead and its workers inside one repository, each with its own telex
 * process, which is exactly that case: sharing a repo can mean sharing a bot, but it can never
 * mean sharing the poll.
 *
 * The oldest running process wins until it exits. Host check-ins may be sparse while a long
 * question waits, but that must not hand polling to a second process.
 */
export function ownerOf(bot: string): string | undefined {
  const live = read()
    .filter((s) => s.bot === bot && running(s.pid))
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.session_id.localeCompare(b.session_id));
  return live[0]?.session_id;
}

/** Drop this session's record. Best effort — a crash is covered by the liveness check instead. */
export function release(sessionId: string) {
  try {
    write(read().filter((s) => s.session_id !== sessionId));
  } catch {
    // nothing useful to do while exiting
  }
}
