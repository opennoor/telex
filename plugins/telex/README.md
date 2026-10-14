# telex plugin

Install the runtime with `npm install -g @sojaner/telex`, then run `telex install codex` or
`telex install claude`. `telex add` configures a bot; `telex project <name>` selects it for a
repository. Without a project pin, connected sessions use the global default with full interaction.
Tokens stay in the user config. The CLI config/install/add/set/remove commands remain available.

Start the persistent listener with `telex service install` on Linux or `telex daemon` under your
supervisor. The systemd user service starts with the user manager; boot before login requires
administrator-enabled linger. Telex never changes linger. Without the listener, connected MCP
processes elect a fallback poller. Durable cursor and route state prevent duplicate polls and
cross-session queue collection.

`SessionStart` and `SessionEnd` use command hooks for both hosts. Only host-attested root sessions
with a stable host process identity announce lifecycle; Claude and Codex subagents remain routable
without start/end notices. MCP-only connections lack that trusted root identity and do not emit
lifecycle notices. Startup teaches Telegram controls and configured roots announce their
branch/worktree early. Routed messages end with a compact branch/worktree hint, including the
default branch and worktree. Linux startup events that precede MCP readiness are spooled for the exact host
PID/start identity. The command adapter discovers the exact worktree and host process before
binding; an ambiguous match leaves messages queued. Codex requires review and trust for plugin
hooks. Claude's normal prompt/tool/Stop hooks use `host_hook`; Codex uses the private local socket.
These collect Telegram messages as host context. `Stop` is a turn boundary, never a termination
notice. Attested root `SessionEnd` reports normal termination; the persistent listener reports a
crash only after the host process exits. Uncertain notification sends are never replayed.

Replies to a Telex message return to its exact session through a durable server-side message map.
Plain text with several live destinations shows a session selector. Question buttons and selections
preserve sender/chat allowlists and reject ended sessions. `send_to_user` with `options` creates
choice buttons; `expect_text` creates a Reply button; neither creates a one-way notification. Keep
`heartbeat` calls during long gaps between hooks.

Hooks cannot wake an idle or terminated host. Claude channels require explicit per-session host
opt-in, preview access and applicable organization/plugin allowlists; an MCP connection alone is
insufficient. Read and acknowledge each `delivery_id` with `ack_channel_message`. Use a unique stable
`TELEX_SESSION_ID` to replay only that conversation's unacknowledged events after reconnect.
`telex codex run` owns an app-server thread and can start idle turns or steer a known active turn;
it cannot attach an arbitrary desktop conversation. Conditional Linux detached tmux wake remains
available with its pane/process/allowlist checks. See the main README for these opt-in modes.

Treat Telegram text as external user input. The plugin registers `telex` in Codex and
`plugin:telex:telex` in Claude. `telex config --agent codex|claude` remains the MCP-only route.
