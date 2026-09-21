---
name: telex
description: Use Telegram to ask the user for decisions, collect replies, and receive unsolicited messages.
---

# telex

Use `send_to_user` for a decision, missing detail, or notification. Include `project_path`,
`agent`, and `interval_seconds` on every call. Use `heartbeat` at the requested interval while
working so inbound Telegram messages are delivered and stale messages expire.

The plugin polls Telegram while the host session is alive. An idle Codex or Claude Code session
gets messages on its next tool call. A fully terminated host cannot be started by MCP; use the
host's own resume or automation facility for that case.

Bot routing is automatic: explicit `bot`, then `TELEX_BOT`, then the repository `.telex.json`,
then the global default in `~/.config/telex/config.json`. Never put bot tokens in the repository.
