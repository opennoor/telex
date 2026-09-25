/** Where each agent keeps its project-scoped MCP config, and how telex gets it there. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type Entry = { command: string; args: string[]; env?: Record<string, string> };

export type Agent = {
  id: string;
  label: string;
  /** Argv the agent's own CLI understands; preferred when the binary is on PATH. */
  cli?: (bot?: string) => string[];
  /** Committed config file, and the gitignored variant when the agent has one. */
  file?: string;
  localFile?: string;
  /** Key path telex writes the entry to, and the per-agent shape of the value. */
  path?: string[];
  value?: (entry: Entry) => unknown;
  /** Codex is the only TOML one; it gets its own writer. */
  toml?: boolean;
};

export function agents(): Agent[] {
  const std = (entry: Entry) => entry;
  return [
    { id: "claude", label: "Claude Code", file: ".mcp.json", path: ["mcpServers", "telex"], value: std,
      cli: (bot) => ["claude", "mcp", "add", "--scope", "project", "telex", ...(bot ? ["--env", `TELEX_BOT=${bot}`] : []), "--", "telex", "serve"] },
    { id: "codex", label: "Codex CLI", file: ".codex/config.toml", localFile: ".codex/config.local.toml", toml: true },
  ];
}

/** What the agent's file should contain, standalone — used for printing and for a fresh file. */
export function snippet(agent: Agent, entry: Entry): string {
  if (agent.toml) return tomlBlock(entry);
  return JSON.stringify(nest(agent.path!, agent.value!(entry)), null, 2);
}

export function tomlBlock(entry: Entry): string {
  const lines = [`[mcp_servers.telex]`, `command = "${entry.command}"`, `args = [${entry.args.map((a) => `"${a}"`).join(", ")}]`];
  if (entry.env) {
    lines.push(``, `[mcp_servers.telex.env]`, ...Object.entries(entry.env).map(([k, v]) => `${k} = "${v}"`));
  }
  return lines.join("\n");
}

const nest = (path: string[], value: unknown) => path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>;

export type Result = { ok: boolean; how: string; output?: string };

/** Run the agent's own installer. Returns null when its binary is not on PATH. */
export function runCli(argv: string[], cwd: string): Result | null {
  const run = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8" });
  if (run.error && (run.error as NodeJS.ErrnoException).code === "ENOENT") return null;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  return { ok: run.status === 0, how: argv.join(" "), output };
}

/** Merge the entry into the agent's config file, keeping whatever else is in there. */
export function writeFileConfig(agent: Agent, entry: Entry, dir: string, local: boolean): Result {
  const rel = (local && agent.localFile) || agent.file!;
  const path = join(dir, rel);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = agent.toml ? mergeToml(existing, entry) : mergeJson(existing, agent, entry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { ok: true, how: `wrote ${rel}` };
}

function mergeJson(existing: string, agent: Agent, entry: Entry): string {
  const root = existing.trim() ? (JSON.parse(existing) as Record<string, unknown>) : {};
  let node = root;
  for (const key of agent.path!.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[agent.path![agent.path!.length - 1]] = agent.value!(entry);
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** Replace an existing [mcp_servers.telex] block (and its sub-tables) or append a new one. */
export function mergeToml(existing: string, entry: Entry): string {
  const lines = existing.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.telex]");
  if (start === -1) {
    const head = existing.trim();
    return `${head ? `${head}\n\n` : ""}${tomlBlock(entry)}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  while (end < lines.length && lines[end].trim().startsWith("[mcp_servers.telex.")) {
    end++;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  }
  const merged = [...lines.slice(0, start), ...tomlBlock(entry).split("\n"), "", ...lines.slice(end)];
  return `${merged.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** A local-only config is worthless if git picks it up anyway. */
export function ensureGitignored(dir: string, rel: string): string | null {
  const path = join(dir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const patterns = [rel, `/${rel}`, `${rel}/`];
  if (existing.split("\n").some((l) => patterns.includes(l.trim()))) return null;
  writeFileSync(path, `${existing.replace(/\n*$/, "")}${existing.trim() ? "\n" : ""}${rel}\n`);
  return ".gitignore";
}
