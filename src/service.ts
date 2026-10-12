/** Linux systemd user-service installation; never changes login/linger settings. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configPath } from "./config.ts";
import { statePath } from "./registry.ts";

const NAME = "telex.service";
export const servicePath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", NAME);

/** Quote systemd syntax, including specifiers and ExecStart environment substitutions. */
const quote = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new Error("telex: service paths cannot contain newline or NUL");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
};
const execQuote = (value: string) => quote(value).replace(/\$/g, () => "$$");

export function serviceUnit(cli: string): string {
  return `[Unit]\nDescription=Telex Telegram listener\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${execQuote(process.execPath)} ${execQuote(resolve(cli))} daemon\nEnvironment=${quote(`TELEX_CONFIG=${resolve(configPath())}`)}\nEnvironment=${quote(`TELEX_STATE=${resolve(statePath())}`)}\nWorkingDirectory=/\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

const systemctl = (args: string[]): string => {
  try { return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) {
    const err = error as Error & { code?: string; stderr?: Buffer; status?: number; stdout?: Buffer };
    if (args[0] === "status" && (err.status === 3 || err.status === 4)) return String(err.stdout ?? err.stderr ?? "not running").trim();
    throw new Error(err.code === "ENOENT" ? "telex: systemctl is not on PATH" : `telex: systemctl --user ${args.join(" ")} failed: ${String(err.stderr ?? err.message).trim()}`);
  }
};

export function serviceCommand(action: string | undefined, cli: string): string {
  if (process.platform !== "linux") throw new Error("telex: service commands require Linux with systemd user services");
  if (action === "install") {
    mkdirSync(dirname(servicePath()), { recursive: true });
    writeFileSync(servicePath(), serviceUnit(cli), { mode: 0o600 });
    systemctl(["daemon-reload"]);
    systemctl(["enable", "--now", NAME]);
    return `Installed and started ${servicePath()}. Runs when your user manager starts; pre-login boot requires administrator-enabled linger.`;
  }
  if (action === "uninstall") {
    systemctl(["disable", "--now", NAME]);
    rmSync(servicePath(), { force: true });
    systemctl(["daemon-reload"]);
    return "Telex user service removed.";
  }
  if (action === "start" || action === "stop") {
    systemctl([action, NAME]);
    return `Telex listener ${action === "start" ? "started" : "stopped"}.`;
  }
  if (action === "status") return systemctl(["status", "--no-pager", NAME]);
  throw new Error("usage: telex service install|start|stop|status|uninstall");
}
