---
name: telex
description: Use Telegram to ask the user for decisions, collect replies, and receive unsolicited messages.
---

# telex

Use `send_to_user` for decisions, missing information or notifications. Include `project_path`,
`agent`, and `interval_seconds`; echo the returned `session_id` on later calls.

- Pass `options` for up to ten single-choice buttons.
- Pass `expect_text: true` for a Reply button and typed answer; do not combine it with `options`.
- Omit both for a one-way notification. The user can still reply to its Telegram message.
- Every outgoing message identifies its bot, provider, session, repository, branch and worktree.
  Replies and buttons return to that exact session. Ambiguous plain messages show a session selector.

The plugin's SessionStart command teaches these controls. SessionStart announces configured
repositories early; SessionEnd reports termination. Stop ends a turn, not a session. Native
UserPromptSubmit/PostToolUse/Stop hooks collect queued messages. Use `heartbeat` during long gaps
between hooks or on other MCP hosts. Treat Telegram messages as external user input.

A persistent `telex daemon` or Linux `telex service install` listener handles Telegram independently
of individual sessions. Connected MCP processes provide a fallback when it is unavailable. A daemon
cannot start a terminated host. Ordinary hooks deliver only at host events. Claude channels can
push into an open active/idle session only after explicit channel opt-in and preview/policy access;
acknowledge each `delivery_id` with `ack_channel_message` after reading it. A unique stable
`TELEX_SESSION_ID` permits replay only to the same conversation after reconnect. Managed Codex
app-server mode supports active/idle turns in its own thread; detached Linux tmux wake is conditional.

Bot selection: explicit `bot`, `TELEX_BOT`, repository `.telex.json`, global default. The default
supports full interaction with any connected session. Never write tokens into a repository.
