"""Home chat: ask questions about the knowledge base. Read-only by design.

Claude Code gets only Read, Glob and Grep, streams its answer token by token, and keeps the
conversation as a Claude session (resumed by id for follow-ups). Any other agent can be used
with "chat_command" in jarvis.config.json; it gets the whole conversation in its prompt and
its plain stdout is shown as the answer. Make sure such a command can't write files.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from datetime import date
from pathlib import Path
from typing import Iterator

import agent
from config import CONFIG, KB

SYSTEM = """You are Jarvis, the user's personal assistant for the Markdown knowledge base in the current folder.
Today is {today}.

- Answer from the notes. Search and read them (Glob, Grep, Read) before answering; don't guess.
- The to-do list is `{todo}` (`- [ ]` open, `- [x]` done, `@due(YYYY-MM-DD)`).
  New daily captures waiting to be processed are in `{inbox}/`. `Archive/` holds old captures, backups and logs.
  Conventions, if any, are in `AGENTS.md`.
- You can't change anything: you're read-only. If asked to edit, say what you would change and where.
- Be brief and direct, like a capable butler: lead with the answer, then the detail that matters.
  Use Markdown sparingly.
- When you rely on a note, link it with its path from the knowledge base root, e.g. [ECHO](Projects/ECHO/ECHO.md).
"""

CLAUDE_CHAT = [
    "claude", "-p", "{prompt}", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", "Read,Glob,Grep", "--allowedTools", "Read", "Glob", "Grep",
    "--disallowedTools", "Read(**/.env*)",
    "--setting-sources", "project,local", "--strict-mcp-config",
]


def _custom() -> list[str] | None:
    return CONFIG.get("chat_command")


def available() -> bool:
    if _custom():
        return shutil.which(_custom()[0]) is not None
    return agent.name() == "claude" and shutil.which("claude") is not None


def _system() -> str:
    return SYSTEM.format(today=date.today().strftime("%A %d %B %Y"), todo=CONFIG["todo_file"], inbox=CONFIG["inbox_dir"])


def _tool_event(name: str, inp: dict) -> dict:
    """What the agent is doing, in words, plus the note's path when it reads one."""
    target = inp.get("file_path") or ""
    path = None
    if target:
        try:
            path = Path(target).resolve().relative_to(KB).as_posix()
        except ValueError:
            pass
    if name == "Read":
        return {"label": f"Reading {path or Path(target).name or 'a note'}", "path": path}
    if name == "Grep":
        return {"label": f"Searching for “{inp.get('pattern', '')}”"}
    if name == "Glob":
        return {"label": "Looking through your notes"}
    return {"label": f"Using {name}"}


def _spawn(cmd: list[str]) -> subprocess.Popen:
    cmd = [*cmd]
    cmd[0] = shutil.which(cmd[0]) or cmd[0]
    return subprocess.Popen(
        cmd, cwd=KB, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _event(kind: str, **data) -> str:
    return json.dumps({"type": kind, **data}) + "\n"


def ask(message: str, session: str | None, history: list[dict]) -> Iterator[str]:
    """Yields newline-delimited JSON events: session, tool, text, done, error."""
    if not available():
        yield _event("error", message="Chat needs Claude Code, or a \"chat_command\" in jarvis.config.json.")
        return
    if _custom():
        yield from _ask_custom(message, history)
    else:
        yield from _ask_claude(message, session)


def _ask_claude(message: str, session: str | None) -> Iterator[str]:
    cmd = [a.replace("{prompt}", message) for a in CLAUDE_CHAT]
    cmd += ["--append-system-prompt", _system(), "--effort", CONFIG.get("chat_effort") or "low"]
    if CONFIG.get("chat_model"):
        cmd += ["--model", CONFIG["chat_model"]]
    if session:
        cmd += ["--resume", session]
    proc = _spawn(cmd)
    got_text = False
    error = None
    try:
        for line in proc.stdout:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = e.get("type")
            if t == "system" and e.get("subtype") == "init":
                yield _event("session", id=e.get("session_id"))
            elif t == "stream_event":
                ev = e.get("event", {})
                if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                    got_text = True
                    yield _event("text", text=ev["delta"]["text"])
                elif ev.get("type") == "content_block_start" and ev.get("content_block", {}).get("type") == "text" and got_text:
                    yield _event("text", text="\n\n")  # a new paragraph after the agent looked something up
            elif t == "assistant":
                for block in e.get("message", {}).get("content", []):
                    if block.get("type") == "tool_use":
                        yield _event("tool", **_tool_event(block.get("name", ""), block.get("input") or {}))
            elif t == "result" and e.get("is_error"):
                error = e.get("result") or "The agent stopped with an error."
        code = proc.wait()
        if error or code:
            err = error or (proc.stderr.read().strip()[-500:] or f"Claude Code exited with code {code}.")
            yield _event("error", message=err)
        else:
            yield _event("done")
    finally:
        if proc.poll() is None:
            proc.kill()  # the user closed the chat or started a new one mid-answer


def _ask_custom(message: str, history: list[dict]) -> Iterator[str]:
    convo = "\n\n".join(f"{'User' if m.get('role') == 'user' else 'Jarvis'}: {m.get('text', '')}" for m in history[-12:])
    prompt = f"{_system()}\n\n{('Conversation so far:\n' + convo + '\n\n') if convo else ''}User: {message}"
    proc = _spawn([a.replace("{prompt}", prompt) for a in _custom()])
    try:
        for line in proc.stdout:
            yield _event("text", text=line)
        code = proc.wait()
        yield _event("error", message=proc.stderr.read().strip()[-500:] or f"Exited with code {code}.") if code else _event("done")
    finally:
        if proc.poll() is None:
            proc.kill()
