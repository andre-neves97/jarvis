"""Runs the configured coding agent on one capture. Any CLI agent works.

Jarvis only needs a command that takes a prompt, runs in the knowledge base folder and can
read and write files. The prompt points the agent at a TASK.md file; conventions live in
AGENTS.md at the knowledge base root, so no agent-specific instructions are needed.
Built-in presets are below; any other agent is set with "agent_command" in jarvis.config.json.

The agent is told to write only into the staging folder. As a safety net, Jarvis
snapshots the knowledge base first; anything the agent changed outside staging is
reverted and turned into a proposal instead, so nothing reaches your notes unreviewed.
"""
from __future__ import annotations

import shutil
import subprocess
import threading
import time
from pathlib import Path

import kb
import review
from config import CONFIG, KB, STAGING

TASK_TEMPLATE = """# Jarvis processing task

Process one daily capture for this knowledge base. Your output is a PROPOSAL that the
user reviews and edits in Jarvis before anything is saved. Do not change the knowledge base directly.

- Capture: `{capture}`
- Staging folder: `{staging}/`

## Steps

1. If `AGENTS.md` exists at the knowledge base root, read it and follow its conventions.
   Use `Template.md` as the starting point for new notes.
2. Read the capture. Decide which existing notes need updating and which new notes are needed.
   Read each existing note before proposing a change to it.
3. For every note you create or change, write the COMPLETE new file content to
   `{staging}/files/<same relative path>`.
   Example: `Projects/ECHO/ECHO.md` -> `{staging}/files/Projects/ECHO/ECHO.md`
4. Write `{staging}/manifest.json` last, in exactly this shape:

```json
{{
  "version": 1,
  "capture": "{capture}",
  "agent": "{agent}",
  "summary": "Two or three sentences: what this capture changes in the knowledge base.",
  "changes": [
    {{
      "path": "Projects/ECHO/ECHO.md",
      "action": "update",
      "summary": "One sentence: what changed in this note and why.",
      "sources": ["short exact quote copied from the capture that justifies this change"]
    }}
  ],
  "todos": [
    {{"text": "Action item for the user", "due": "YYYY-MM-DD or null", "source": "exact quote from the capture"}}
  ],
  "skipped": [
    {{"what": "Something in the capture you chose not to store", "why": "reason"}}
  ]
}}
```

## Rules

- Write ONLY inside `{staging}/`.
- Do not edit, move or delete any other file: not the capture, not `Archive/`, not `todo.md`.
  Jarvis makes the backup, change log and proposal log and archives the capture after the user approves.
- Keep each note's existing structure and wording except where the change requires otherwise.
- `sources` quotes must be copied verbatim from the capture (Jarvis highlights them for the user).
"""

_runs: dict[str, dict] = {}
_lock = threading.Lock()


# Built-in agents. "{prompt}" is replaced with the task prompt. To add another AI system,
# add a line here, or set "agent_command" (and optionally "agent_label") in jarvis.config.json.
PRESETS: dict[str, dict] = {
    "copilot": {"label": "Copilot", "command": ["copilot", "-p", "{prompt}", "--allow-all-tools"]},
    "claude": {"label": "Claude Code", "command": [
        "claude", "-p", "{prompt}", "--permission-mode", "acceptEdits",
        "--allowedTools", "Read", "Glob", "Grep", "Write", "Edit",
        "--disallowedTools", "Bash", "Read(**/.env*)",
        # Headless run: skip personal plugins, hooks and MCP servers, which can stall or slow a
        # non-interactive session. Project settings and CLAUDE.md -> AGENTS.md still apply.
        "--setting-sources", "project,local", "--strict-mcp-config",
    ]},
}


def name() -> str:
    return CONFIG.get("agent") or "none"


def _template() -> list[str] | None:
    return CONFIG.get("agent_command") or PRESETS.get(name(), {}).get("command")


def label() -> str:
    return CONFIG.get("agent_label") or PRESETS.get(name(), {}).get("label") or name()


def available() -> bool:
    tpl = _template()
    return bool(tpl) and shutil.which(tpl[0]) is not None


def _command(prompt: str) -> list[str]:
    tpl = _template()
    if not tpl:
        raise RuntimeError("No agent configured")
    cmd = [a.replace("{prompt}", prompt) for a in tpl]
    cmd[0] = shutil.which(cmd[0]) or cmd[0]
    return cmd


def running() -> set[str]:
    """Captures being processed now or waiting in the queue."""
    with _lock:
        return {rid for rid, r in _runs.items() if r["status"] in ("running", "queued")}


def queued() -> set[str]:
    with _lock:
        return {rid for rid, r in _runs.items() if r["status"] == "queued"}


def status(rid: str) -> dict:
    with _lock:
        r = _runs.get(rid)
        if not r:
            return {"status": "idle", "log": ""}
        return {"status": r["status"], "log": "".join(r["log"][-400:]), "error": r.get("error")}


_queue: list[str] = []
_worker: threading.Thread | None = None


def start(rid: str) -> None:
    enqueue([rid])


def enqueue(ids: list[str]) -> int:
    """Queue captures for processing. One agent runs at a time, oldest capture first,
    so each run's safety net only ever sees its own agent's changes."""
    global _worker
    if not available():
        raise RuntimeError(f"{label()} was not found on this machine")
    for rid in ids:
        if not review.capture_path(rid):
            raise RuntimeError(f"Capture not found: {rid}")
    busy = running()
    added = 0
    with _lock:
        for rid in sorted(ids):
            if rid in busy or rid in _queue:
                continue
            _queue.append(rid)
            _runs[rid] = {"status": "queued", "log": [], "started": None}
            added += 1
        if _queue and (_worker is None or not _worker.is_alive()):
            _worker = threading.Thread(target=_work, daemon=True)
            _worker.start()
    return added


def _work() -> None:
    while True:
        with _lock:
            if not _queue:
                return
            rid = _queue.pop(0)
        try:
            prompt, d = _prepare(rid)
            _run(rid, prompt, d)
        except Exception as e:  # noqa: BLE001
            with _lock:
                _runs[rid].update(status="failed", error=f"Could not process this capture: {e}")


def _prepare(rid: str) -> tuple[str, Path]:
    capture = review.capture_path(rid)
    if not capture:
        raise RuntimeError("Capture not found")
    d = STAGING / rid
    if d.exists():
        shutil.rmtree(d)
    (d / "files").mkdir(parents=True)
    staging_rel = kb.relpath(d)
    (d / "TASK.md").write_text(
        TASK_TEMPLATE.format(capture=capture, staging=staging_rel, agent=name()), "utf-8")
    prompt = f"Read {staging_rel}/TASK.md and carry out the task it describes."
    with _lock:
        _runs[rid].update(status="running", started=time.time())
    return prompt, d


def _log(rid: str, text: str) -> None:
    with _lock:
        _runs[rid]["log"].append(text)


def _run(rid: str, prompt: str, d: Path) -> None:
    before = kb.snapshot()
    try:
        proc = subprocess.Popen(
            _command(prompt), cwd=KB, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        for line in proc.stdout:
            _log(rid, line)
        code = proc.wait()
    except Exception as e:  # noqa: BLE001
        code = -1
        _log(rid, f"\nCould not start the agent: {e}\n")
    warnings = _safety_net(rid, before, d)
    manifest_path = d / "manifest.json"
    if not manifest_path.exists():
        staged = [p for p in (d / "files").rglob("*") if p.is_file()]
        if staged or warnings:
            m = review.empty_manifest(rid, name())
            m["changes"] = [{"path": p.relative_to(d / "files").as_posix(), "action": "update",
                             "summary": "Proposed by the agent (no manifest was written)", "sources": []} for p in staged]
            review._save_json(manifest_path, m)
    if warnings:
        m = review._load_json(manifest_path, review.empty_manifest(rid, name()))
        m.setdefault("warnings", []).extend(warnings)
        review._save_json(manifest_path, m)
    with _lock:
        r = _runs[rid]
        if manifest_path.exists():
            r["status"] = "done"
        else:
            r["status"] = "failed"
            r["error"] = f"The agent finished (exit code {code}) without writing a proposal. Check the log."


def _safety_net(rid: str, before: dict[str, bytes], d: Path) -> list[str]:
    after = kb.snapshot()
    warnings: list[str] = []
    staging_prefix = kb.relpath(d) + "/"
    manifest = review._load_json(d / "manifest.json", None)
    for rel in sorted(set(before) | set(after)):
        if rel.startswith(staging_prefix):
            continue
        old, new = before.get(rel), after.get(rel)
        if old == new:
            continue
        if new is not None and kb.is_own_write(rel, kb.sha(new.decode("utf-8-sig", "replace").replace("\r\n", "\n"))):
            continue  # the user saved this in Jarvis while the agent ran
        p = KB / rel
        # Put the knowledge base back the way it was.
        if old is None:
            p.unlink(missing_ok=True)
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(old)
        if new is None:
            warnings.append(f"The agent deleted {rel}. Jarvis restored it.")
        elif rel.startswith("Archive/") or rel.startswith(review.INBOX + "/") or rel == review.TODO:
            warnings.append(f"The agent wrote to {rel}. Jarvis undid it; archiving and to-dos happen when you apply.")
        else:
            staged = d / "files" / rel
            if not staged.exists():
                staged.parent.mkdir(parents=True, exist_ok=True)
                staged.write_bytes(new)
                if manifest is not None:
                    manifest["changes"].append({"path": rel, "action": "create" if old is None else "update",
                                                "summary": "The agent edited this note directly; Jarvis moved the edit here for review.",
                                                "sources": []})
            warnings.append(f"The agent edited {rel} directly. Jarvis undid it and added the edit to this review.")
    if manifest is not None:
        review._save_json(d / "manifest.json", manifest)
    return warnings
