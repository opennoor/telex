# telex plugin

This package exposes the telex MCP server to Codex and Claude Code.

1. Install the runtime: `npm install -g @sojaner/telex`.
2. Install this plugin using the host's local plugin installer.
3. In the repository, run `telex add` once and `telex project <name>` to select its bot.

The server long-polls Telegram while the host session is alive. MCP has no documented external
start-turn operation in Codex or Claude Code, so a fully terminated host cannot be woken by this
plugin; use the host's resume or automation feature for that case.
