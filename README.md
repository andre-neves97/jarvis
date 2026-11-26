# Jarvis

A local app for your Markdown knowledge base: read and edit notes, keep a to-do list,
and review agent-processed daily captures before anything is saved.

## Start

Double-click `start.bat`. The first run sets up Python and builds the interface (needs Python 3.11+ and Node 18+).
Then it opens http://127.0.0.1:8765. It only listens on your own machine.

## One config per machine

`jarvis.config.json` sits next to this README and is not synced with the knowledge base:

```json
{ "kb_path": "C:/Users/<you>/OneDrive/Knowledge Base", "agent": "claude" }
```

- `agent`: `"claude"` (Claude Code), `"copilot"` (GitHub Copilot CLI) or `"none"` (manual review only).

### Any other AI system

Jarvis works with any command-line agent that takes a prompt and can read and write files.
Give the exact command, with `{prompt}` where the task goes, and a name for the UI:

```json
{
  "kb_path": "../Knowledge Base",
  "agent": "myagent",
  "agent_command": ["myagent", "--non-interactive", "{prompt}"],
  "agent_label": "My Agent"
}
```

The agent runs in the knowledge base folder and is told to read a `TASK.md` file. All conventions live in
`AGENTS.md` at the knowledge base root (Claude Code reads it through the `@AGENTS.md` import in `CLAUDE.md`;
give other agents the equivalent if they look for a different file). Whatever the agent does,
Jarvis undoes direct edits to your notes and turns them into proposals, so nothing is saved without review.

## How a review works

1. Inbox → **Process with <your agent>**. The agent writes its proposal into `.jarvis/staging/<capture>/`
   inside the knowledge base, never into your notes.
   If it edits notes directly anyway, Jarvis undoes that and adds the edit to the review.
2. **Open review**: the capture opens on the left; each proposed note opens on the right as an editable diff.
   Type straight into the proposal, use Accept/Reject on single changes, then Accept or Reject the note.
3. **Apply**: Jarvis zips a backup to `Archive/Backups/`, writes the accepted notes, adds ticked to-dos to `todo.md`,
   writes `Archive/Proposals/<time>.md` and a `ChangeLog.md` entry, and moves the capture to `Archive/ProcessingBay/`.

You can also **Review manually** without an agent: add the notes you want to change and edit them next to the capture.

## Development

```
cd frontend && npm run dev        # UI on :5173, proxies /api
.venv\Scripts\python backend\server.py
```
