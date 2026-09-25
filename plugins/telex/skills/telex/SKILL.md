---
name: telex
description: Use Telegram to ask the user for decisions, collect replies, and receive unsolicited messages.
---

# telex

Use `send_to_user` for a decision, missing detail, or notification. Include `project_path`,
`agent`, and `interval_seconds` on tool calls. The plugin's native hooks check in and deliver
queued messages at `UserPromptSubmit`, after `PostToolUse`, and at `Stop`. Use `heartbeat` manually
as a fallback on hosts without these hooks or during long reasoning stretches between hook events.

The plugin polls Telegram while the host session is alive. These hooks deliver messages only when
the host reaches a configured event; they do not wake an idle or terminated host. Use the host's
own resume or automation facility for that case.

Bot routing is automatic: explicit `bot`, then `TELEX_BOT`, then the repository `.telex.json`,
then the global default in `~/.config/telex/config.json`. Never put bot tokens in the repository.
