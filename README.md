# telex

An MCP server that lets local AI agents talk to you through Telegram — ask a question, offer
buttons, collect a typed reply, and give up gracefully when you are away.

Your agent is running a long task, hits a decision it shouldn't make alone, and you are not at
the keyboard. Instead of guessing or stalling, it sends you a Telegram message with two buttons
and waits. You tap one from your phone; the agent carries on with your answer. If you never
answer, the buttons come off, the message is marked stale, and the agent decides for itself
whether to stop or continue.

telex is local-only: it runs over stdio next to your agent, talks outbound to the Telegram Bot
API, and only ever messages the chats you configured. Nothing listens on a port.

```
┌────────┐   stdio/MCP   ┌───────┐   Bot API   ┌──────────┐
│ agent  │ ────────────▶ │ telex │ ──────────▶ │ Telegram │ ──▶ you
└────────┘   ◀────────── └───────┘   ◀────────  └──────────┘
             the answer               your tap
```

---

## Install

```sh
npm i -g @sojaner/telex
```

Requires Node 22.6 or newer. The binary is called `telex` whatever you install it from.

Pin a version, or take it straight from the GitHub release if you prefer not to go through
the registry:

```sh
npm i -g @sojaner/telex@0.1          # a range, or any exact published version
npm i -g https://github.com/Sojaner/telex/releases/latest/download/telex.tgz
npm i -g https://github.com/Sojaner/telex/releases/download/v0.1.14/telex.tgz
```

After CI passes on `main`, the release workflow publishes the version declared in `package.json`
and attaches the same tarball to a GitHub release. If that version is already tagged, the workflow
increments the patch version instead, so both routes carry identical builds.

Or run it from a checkout:

```sh
git clone https://github.com/Sojaner/telex && cd telex
corepack enable && pnpm install
node src/cli.ts --help          # runs the TypeScript directly, no build
pnpm run build && pnpm link --global   # or link this checkout as the global telex
```

Upgrade with the same install command; uninstall with `npm rm -g @sojaner/telex`.

### Codex and Claude plugins

This repository also contains an installable plugin for Codex and Claude Code. Install telex first,
then install the `plugins/telex` directory from this checkout (or from an unpacked published package)
so the host registers the `telex` MCP server. The plugin contains no bot tokens. Its Codex manifest
is `plugins/telex/.codex-plugin/plugin.json`; its Claude manifest is `plugins/telex/.claude-plugin/plugin.json`.

---

## Set up a bot

Create the bot in Telegram, then let telex do the rest:

```sh
telex add
```

It walks you through three things:

1. **The token.** Open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a display name
   and a username ending in `bot`. BotFather replies with a token like `8123456789:AAH…`. Paste
   it in. telex validates it against `getMe` before going further.
2. **The chat.** telex prints your bot's link and waits. Open the chat and send it anything —
   telex reads the chat id and your Telegram user id straight off that message, so you never
   have to read raw `getUpdates` JSON.
3. **A name.** How you'll refer to this bot later (`main`, `work`, `acme-api`). The first bot
   added becomes the default.

It writes `~/.config/telex/config.json` with mode `0600` and sends a test message so you know the
round trip works.

Run `telex add` again for each additional bot. One bot per project is the point — see
[Per-project configuration](#per-project-configuration).

### Groups

Point a bot at a group instead of a DM: add the bot to the group, run `telex add`, and send the
message from inside the group. Group chat ids are negative; telex picks that up automatically.

Set `allowFrom` for groups. An inline keyboard is tappable by **everyone** who can see it, and
telex checks the tapping user against that list — without it, any group member can answer your
agent's questions.

### Doing it by hand

```sh
telex add work --token '8123456789:AAH…' --chat-id 987654321 --allow 987654321
telex add team --token '8234567890:AAG…' --chat-id=-1001234567890 --allow 987654321,123456789
```

Negative chat ids need `--chat-id=-100…` (with the equals sign), because a bare `-100…` looks
like another flag.

---

## Managing bots

```
telex add [name]              add a bot, guided; or --token … --chat-id …
telex list                    configured bots, tokens masked
telex set <name> [options]    change token / chat / allowlist / default
telex remove <name>           delete a bot
telex config [name]           install the MCP registration into this project
telex project <name>          pin this repository to a configured bot
telex serve                   run the MCP server over stdio (what agents launch)
```

Options for `add` and `set`:

| Flag | Meaning |
|---|---|
| `--token <token>` | Bot token from BotFather |
| `--chat-id <id>` | Chat the bot writes to (`--chat-id=-100…` for groups) |
| `--allow <id,id>` | Telegram user ids allowed to answer; `any` clears the list |
| `--default` | Make this the global default bot |

```sh
$ telex list
* work             chat 987654321        8123456789:******bAcD  allow: 987654321
  team             chat -1001234567890   8234567890:******xYzW  allow: 987654321, 123456789

* = default. Config: /home/you/.config/telex/config.json
```

`telex list --json` prints the same thing as JSON, tokens still masked.

---

## The config file

`~/.config/telex/config.json`, or wherever `TELEX_CONFIG` points. `XDG_CONFIG_HOME` is honoured.

```json
{
  "defaultBot": "work",
  "bots": {
    "work": {
      "token": "8123456789:AAH…",
      "chatId": 987654321,
      "allowFrom": [987654321]
    },
    "team": {
      "token": "8234567890:AAG…",
      "chatId": -1001234567890,
      "allowFrom": [987654321, 123456789]
    }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `defaultBot` | no | Bot used when nothing else specifies one. Defaults to the first entry. |
| `bots.<name>.token` | yes | BotFather token. Keep this file at `0600`; it is a credential. |
| `bots.<name>.chatId` | yes | Chat the bot writes to. Negative for groups and channels. |
| `bots.<name>.allowFrom` | no | Telegram user ids allowed to answer. Omit to trust anyone in the chat. |

The file is shared by every project on the machine; projects select a bot from it rather than
keeping their own copy of your tokens.

---

## Registering with an agent

```sh
cd ~/code/acme-api
telex config
```

asks whether this directory is the project you mean, then which agent to install for, and does
the install: it runs that agent's own CLI when it has one, and writes the config file itself when
it does not. The server command is always `telex serve`.

| Flag | Meaning |
|---|---|
| `--agent <id>` | skip the prompts: `claude`, `gemini`, `qwen`, `codex`, `cursor`, `roo`, `vscode`, `zed`, `amp`, `opencode`, `crush` |
| `--scope local\|project` | for agents with both: the gitignored file or the committed one |
| `--print` | only show the commands and file shapes; write nothing |
| `-y` | don't ask about the current directory |
| `--json` | print just the `mcpServers` object |

Required for a non-interactive run: `--agent`, plus `--scope` for agents that have both files.
Writing a file merges into whatever is already there rather than replacing it, and `--scope local`
adds the file to `.gitignore`.

Agents that install it themselves — `telex config --agent claude` runs:

```sh
claude mcp add --scope project telex -- telex serve      # Claude Code
gemini mcp add --scope project telex telex serve         # Gemini CLI
qwen mcp add --scope project telex telex serve           # Qwen Code
```

Agents telex configures by writing the file — same server, different shape per agent:

| Agent | File | Shape |
|---|---|---|
| Claude Code | `.mcp.json` | `{"mcpServers": {"telex": {"command": "telex", "args": ["serve"]}}}` |
| Cursor | `.cursor/mcp.json` | same as above |
| Roo Code | `.roo/mcp.json` | same as above |
| VS Code | `.vscode/mcp.json` | `{"servers": {"telex": {"type": "stdio", "command": "telex", "args": ["serve"]}}}` |
| Zed | `.zed/settings.json` | `{"context_servers": {"telex": {"source": "custom", "command": "telex", "args": ["serve"]}}}` |
| Amp | `.amp/settings.json` | `{"amp.mcpServers": {"telex": {"command": "telex", "args": ["serve"]}}}` |
| opencode | `opencode.json` | `{"mcp": {"telex": {"type": "local", "command": ["telex", "serve"]}}}` |
| Crush | `.crush.json` | `{"mcp": {"telex": {"type": "stdio", "command": "telex", "args": ["serve"]}}}` |
| Codex CLI | `.codex/config.toml` or `.codex/config.local.toml` | `[mcp_servers.telex]` / `command = "telex"` / `args = ["serve"]` |

Codex is the one with two files: `.codex/config.toml` is committed and shared with the team,
`.codex/config.local.toml` is your own and gitignored — `--scope project` or `--scope local`.
Codex only reads either for projects you have marked trusted. Anything else that
speaks MCP takes the `mcpServers` shape — `claude_desktop_config.json`, Continue, and the rest.

For one bot everywhere instead of one
per project, install at user scope: `claude mcp add --scope user telex -- telex serve`.

If `telex` is not on the agent's `PATH` — GUI apps often have a shorter `PATH` than your shell —
use the absolute path, or point Node at the installed entry point:

```json
{
  "mcpServers": {
    "telex": {
      "command": "node",
      "args": ["/home/you/.npm-global/lib/node_modules/telex/dist/index.js"]
    }
  }
}
```

`telex config --print` prints that path for your machine.

### Per-project configuration

Give each project its own bot, so a message tells you which project it came from before you even
read it, and you can mute one project's bot without muting the rest.

```sh
cd ~/code/acme-api
telex add acme-api                       # its own bot, its own chat
telex config acme-api                    # same install, pinned to that bot
```

which threads `TELEX_BOT=acme-api` into whatever it installs:

```sh
claude mcp add --scope project telex --env TELEX_BOT=acme-api -- telex serve
```

```json
{
  "mcpServers": {
    "telex": {
      "command": "telex",
      "args": ["serve"],
      "env": { "TELEX_BOT": "acme-api" }
    }
  }
}
```

Commit that `.mcp.json` and everyone on the project gets the right routing — they each configure
their own bot named `acme-api` with their own token, and nothing secret goes in the repo.

Which bot a message goes to, in order:

1. The `bot` argument on the tool call, if the agent passes one.
2. `TELEX_BOT` from the MCP registration — the project's bot.
3. `.telex.json` in the repository — written by `telex project <name>` or `telex config <name>`.
4. `defaultBot` from the config file.

So a project's agent messages its own bot without being told to, and can still reach another bot
deliberately (`bot: "oncall"` for something urgent, say).

---

## The tools

The server exposes two tools. `send_to_user` starts the conversation:

| Parameter | Type | Meaning |
|---|---|---|
| `project` | string, required | Task or project name, rendered as the bold heading. |
| `message` | string, required | The copy to show you, in Telegram HTML. |
| `options` | string[], optional | Up to 10 single-choice answers, rendered as buttons. |
| `expect_text` | boolean, optional | Show one *Reply* button; your next message becomes the answer. |
| `timeout_seconds` | number, default 300 | Deadline for the whole exchange, 5s to 24h. |
| `bot` | string, optional | Which configured bot to use. |
| `project_path` | string, required | Absolute path of the project the agent is working in. |
| `agent` | string, required | The agent's own name, e.g. `claude-code`. |
| `interval_seconds` | number, default 60 | How often the agent calls `heartbeat`. |
| `session_id` | string, optional | The `session_id` from the agent's previous telex result. |

`options` and `expect_text` are mutually exclusive. With neither, the message is a one-way
notification and the call returns immediately.

**Formatting.** `message` is rendered with Telegram's HTML subset: `<b> <i> <u> <s> <code> <pre>
<a href=""> <blockquote>`. Literal `&`, `<` and `>` must be escaped as `&amp; &lt; &gt;`. Markdown
is not rendered.

Agents write ordinary HTML and Markdown anyway, so telex translates before sending:

- `<br>` and `</p>` become newlines, `<li>` becomes a bullet, layout tags (`<p>`, `<div>`, `<ul>`)
  are dropped, and anything else Telegram doesn't know is escaped so it shows as text instead of
  breaking the parse.
- `**bold**`, `` `code` ``, ``` ``` ``` fences and `[links](url)` are converted. Single-asterisk
  italics are left alone, because globs and filenames use asterisks too.

Only if the result still won't parse is the message re-sent as plain text, with the tags stripped
rather than left visible.

**Results.**

```json
{"status": "sent",     "message_id": 101}
{"status": "answered", "response": "Yes", "kind": "choice", "message_id": 101}
{"status": "timeout",  "message_id": 101}
```

On `timeout` the buttons are stripped and the message is marked stale, so a late tap can't answer
a question nobody is listening to any more. What happens next — retry, continue without you,
stop — is entirely the agent's call. telex has no opinion.

If you messaged the bot while the agent wasn't asking anything, the result carries those messages
too, delivered exactly as a heartbeat would:

```json
{"status": "sent", "message_id": 101, "pending": [{"text": "hold off on the deploy", "received_at": "2026-09-15T18:22:04.000Z", "waited_seconds": 37}]}
```

### Messages you send first

You can talk to the bot without being asked. While an agent session is open, telex long-polls
Telegram continuously and queues inbound messages immediately; the host still decides when the
model reads them. An MCP server cannot wake a fully terminated Codex or Claude Code process: their
documented MCP transports (stdio, HTTP, or SSE) connect tools but do not start an agent turn. An
idle session receives the message on its next tool call/heartbeat; a terminated host requires its
own resume or automation facility. Telex holds what you said until the agent checks in, and edits
a single receipt under your message as it moves:

| What you see | What it means |
|---|---|
| 🕦 *Held for the agent's next check-in.* | telex has your message and is holding it. |
| ‼️ *Not accepted — no agent has checked in for this project yet.* | The server is running but no agent has identified itself. Nothing is holding your message. |
| 📬 *Delivered to the agent.* | A heartbeat collected it; the agent has it now. |
| 🗑️ *Expired — the agent never picked this up.* | Three intervals passed with no check-in. Dropped. |
| *nothing at all* | Nothing is running for that project. The message went nowhere. |

Silence is the signal: telex only polls while its process is alive, so a message with no receipt
at all means no agent is there to receive it. Held messages are capped at 50 per chat, oldest
dropped.

### `heartbeat`

The agent's side of that. It calls this on a fixed interval for as long as it is working, and the
call returns immediately — it never blocks and never waits for you.

| Parameter | Type | Meaning |
|---|---|---|
| `interval_seconds` | number, default 60 | How often the agent intends to check in, 10s to 1h. |
| `project_path` | string, required | Absolute path of the project. |
| `agent` | string, required | The agent's own name. |
| `session_id` | string, optional | The `session_id` from the previous result. |
| `bot` | string, optional | Which configured bot to listen on. |

```json
{"messages": [{"text": "ship it", "received_at": "2026-09-15T18:22:04.000Z", "waited_seconds": 12}], "interval_seconds": 60}
```

An empty `messages` array is the normal case — nothing was said, keep working. The interval does
double duty as a liveness signal: miss three in a row and anything waiting is marked expired and
dropped, so you learn the agent stopped listening instead of watching a message sit unanswered
forever.

### Who is calling

Every tool call carries `project_path`, `agent` and `interval_seconds`, and every result hands back
a `session_id` for the agent to echo on its next call. That does four things:

- **The expiry clock starts at the first call**, not the first heartbeat. A message you send a
  second later already has a deadline.
- **Messages sent before any agent has checked in are refused**, not held. The server starts with
  your agent, but until the agent actually calls a telex tool nothing owns the bot — telex says so
  rather than quietly stockpiling messages for an agent that may never ask.
- **One session stays one agent.** The `session_id` is what telex matches on, not the name or the
  process. A session that renames itself mid-run — a subagent taking over a heartbeat, a handoff
  between models — is still the same agent, not a second one competing for the bot. An agent that
  never echoes it still gets one stable identity for the life of the server process.
- **Two projects on one bot get caught.** Each running agent records itself in
  `~/.local/state/telex/sessions.json` (override with `TELEX_STATE`), so separate telex processes
  can see each other. When a second one appears on the same bot you get:

  > ⚠️ **Two agents are using this bot at once**
  > `claude-code` — `/code/acme-api`
  > `codex` — `/code/other`
  > Telegram gives each message to only one of them, so answers will go missing.

  That is not a cosmetic warning. Telegram hands each update to exactly one poller, so a shared
  bot loses roughly half of everything you send. Give each project its own bot.

Worktrees are exempt. Agents in `~/code/acme` and `~/code/acme.worktrees/fix` resolve to the same
repository, so they count as one project and no warning fires — they are branches of one piece of
work, and you asked for them to share a bot by pointing them at one. The cost is real though:
Telegram still gives each message to one poller only, so two worktrees on one bot will each see
about half of what you send. Give a long-running worktree its own bot if that matters.

A record is live while its process exists and it has checked in within three intervals; crashed
and stale ones are pruned on the next call, so the warning doesn't fire for agents that are gone.

### Examples

A decision:

```json
{
  "project": "acme-api",
  "message": "Migration <code>0042_drop_legacy_users</code> is destructive and irreversible.\nRun it against <b>production</b>?",
  "options": ["Run it", "Skip for now", "Stop and wait for me"],
  "timeout_seconds": 1800
}
```

Missing information:

```json
{
  "project": "acme-api",
  "message": "What should the new endpoint be called?",
  "expect_text": true,
  "timeout_seconds": 600
}
```

A notification, no answer wanted:

```json
{
  "project": "nightly",
  "message": "✅ Test suite green, 412 passed in 3m12s.\nBranch <code>fix/token-refresh</code> is ready to merge.",
  "bot": "alerts"
}
```

---

## Behaviour worth knowing

- **Long messages** are split at Telegram's limit; only the last part carries the buttons.
- **Long choices** — anything over 24 characters — are listed in the message body and the buttons
  become `1`, `2`, `3`, because Telegram truncates long button labels.
- **Stale updates are discarded.** Messages you sent before the question was asked are never read
  as an answer.
- **Slash commands are ignored** as text answers, so `/start` and friends still work.
- **Rate limits** are honoured: a `429` is retried after the `retry_after` Telegram asks for.
- **Tokens are redacted** from error messages; they appear in the API URL that failed.
- **Polling runs while the process does.** Once a project's bot is watched telex long-polls for
  the life of the server, because being reachable is what makes "delivered" mean anything. Kill
  the agent and the bot goes quiet.
- **Unprompted messages are held, not answered with.** A message you send while nothing is asking
  is queued for the agent instead of being read as the answer to whatever gets asked next.
- **`allowFrom` covers inbound too.** Someone else in the group messaging the bot is dropped, not
  queued.
- **One poller per token.** Two processes polling the same bot fight over updates; give telex its
  own bot. It says so explicitly if it detects a conflict.

---

## Security notes

- The config file holds bot tokens. telex writes it `0600`; keep it that way, and don't commit it.
- Set `allowFrom` anywhere the chat has more than you in it. Buttons are visible and tappable by
  every member; telex authorises the tap, not just the send.
- A bot can only message chats it is already in, and telex only ever sends to the configured
  `chatId`. It does not accept inbound commands or expose an HTTP endpoint.
- The agent chooses what to send. Treat the message body as something the agent wrote — don't
  ask it to relay secrets you wouldn't want in a Telegram chat.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no bots configured` | Run `telex add`, or point `TELEX_CONFIG` at the right file. |
| `Telegram rejected that token` | Paste the whole BotFather line, including the digits before the colon. |
| Nothing arrives, no error | Wrong `chatId`, or you never messaged the bot. Check with `telex list`. |
| `getUpdates conflict` | Another process is polling the same token. Give telex its own bot. |
| Agent can't start the server | `telex` isn't on its `PATH`; use the absolute `node …/dist/index.js` form. |
| Buttons do nothing | The tapping account isn't in `allowFrom`. `telex set <name> --allow <id>`. |
| You message the bot, nothing replies | Nothing is running for that project — start the agent. That silence is deliberate. |
| Messages stay "held" | The agent isn't calling `heartbeat`. It will still see them on its next tool call. |
| Everything is "not accepted" | The agent hasn't called any telex tool yet, so nothing owns the bot. |
| Warned about two agents | Two projects share one bot. `telex add <name>` and repoint one of them. |
| Messages expire constantly | The agent's `interval_seconds` is shorter than how often it really checks in. |

Run the server by hand to see startup errors that an agent would swallow:

```sh
telex serve < /dev/null
```

---

## Development

This repo uses **pnpm**. `npm install` in a checkout stops at a `preinstall` guard telling you
so, CI fails on a committed `package-lock.json` or `yarn.lock`, and `pnpm install --frozen-lockfile`
fails the build if `package.json` and `pnpm-lock.yaml` ever drift apart. The published package is
unaffected: the guard is stripped at pack time, so installing telex runs no scripts at all.

```sh
corepack enable   # uses the pnpm version pinned in packageManager
pnpm install
pnpm test         # node:test, no network
pnpm run typecheck
pnpm run build    # tsc → dist/, normally done by CI
node src/cli.ts   # run from source; Node strips the types
```

`dist/` is not committed. CI runs the tests on Node 22 and 24 with a frozen lockfile, then tags and
publishes the declared version (or increments an already-tagged version) with the built tarball attached.

## License

MIT
