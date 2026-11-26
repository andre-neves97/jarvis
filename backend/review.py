"""Inbox + review sessions.

Layout of one review (one per capture), inside the knowledge base so it syncs:

    .jarvis/staging/<capture-stem>/
        TASK.md         instructions handed to the agent
        manifest.json   written by the agent (what changed and why)
        files/<path>    the agent's proposed version of each note (never modified by Jarvis)
        edits/<path>    the user's working version, once they type into it
        state.json      Jarvis-owned: per-file decisions, base hashes, to-do decisions
"""
from __future__ import annotations

import json
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

import kb
from config import CONFIG, KB, STAGING

INBOX = CONFIG["inbox_dir"]
TODO = CONFIG["todo_file"]


class ReviewError(Exception):
    def __init__(self, message: str, detail: dict | None = None):
        super().__init__(message)
        self.detail = detail or {}


# ---------- helpers ----------

def _dir(rid: str) -> Path:
    d = (STAGING / rid).resolve()
    if STAGING.resolve() not in d.parents:
        raise ReviewError("Invalid review id")
    return d


def _load_json(p: Path, default):
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text("utf-8-sig"))
    except json.JSONDecodeError as e:
        raise ReviewError(f"{p.name} is not valid JSON: {e}")


def _save_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")


def _text(p: Path) -> str:
    return p.read_bytes().decode("utf-8-sig", errors="replace").replace("\r\n", "\n")


def _current(path: str) -> str | None:
    try:
        p = kb.resolve(path)
    except kb.OutsideKB:
        return None
    return kb.read_text(path) if p.exists() else None


def capture_path(rid: str) -> str | None:
    for p in (KB / INBOX).glob(rid + ".*"):
        return kb.relpath(p)
    return None


def empty_manifest(rid: str, agent: str) -> dict:
    return {
        "version": 1,
        "capture": capture_path(rid),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "agent": agent,
        "summary": "",
        "changes": [],
        "todos": [],
        "skipped": [],
    }


# ---------- inbox ----------

def inbox(running: set[str], queued: set[str] = frozenset()) -> list[dict]:
    folder = KB / INBOX
    items = []
    if folder.exists():
        for p in sorted(folder.iterdir(), reverse=True):
            if not p.is_file() or p.suffix.lower() not in kb.TEXT_EXT:
                continue
            rid = p.stem
            has_review = (_dir(rid) / "manifest.json").exists()
            if rid in queued:
                status = "queued"
            elif rid in running:
                status = "running"
            else:
                status = "review" if has_review else "new"
            items.append({"id": rid, "path": kb.relpath(p), "status": status})
    return items


# ---------- review read/write ----------

def get(rid: str) -> dict:
    d = _dir(rid)
    manifest = _load_json(d / "manifest.json", None)
    if manifest is None:
        raise ReviewError("No review exists for this capture yet")
    state = _load_json(d / "state.json", {"changes": {}, "todos": {}})
    dirty_state = False
    changes = []
    for ch in manifest.get("changes", []):
        path = ch["path"].replace("\\", "/").lstrip("/")
        proposed_file = d / "files" / path
        if not proposed_file.exists():
            continue
        proposed = _text(proposed_file)
        edit_file = d / "edits" / path
        working = _text(edit_file) if edit_file.exists() else proposed
        current = _current(path)
        st = state["changes"].setdefault(path, {})
        if "base_sha" not in st:
            st["base_sha"] = kb.sha(current) if current is not None else None
            dirty_state = True
        cur_sha = kb.sha(current) if current is not None else None
        changes.append({
            "path": path,
            "action": "create" if current is None else ch.get("action", "update"),
            "summary": ch.get("summary", ""),
            "sources": ch.get("sources", []),
            "status": st.get("status", "pending"),
            "original": current or "",
            "proposed": proposed,
            "working": working,
            "edited": working != proposed,
            "stale": cur_sha != st["base_sha"],
            "origin": ch.get("origin", "agent"),
        })
    todos = []
    for i, t in enumerate(manifest.get("todos", [])):
        st = state["todos"].get(str(i), {})
        todos.append({
            "index": i,
            "text": st.get("text", t.get("text", "")),
            "due": st.get("due", t.get("due")),
            "source": t.get("source", ""),
            "include": st.get("include", True),
        })
    if dirty_state:
        _save_json(d / "state.json", state)
    return {
        "id": rid,
        "capture": manifest.get("capture") or capture_path(rid),
        "agent": manifest.get("agent", ""),
        "summary": manifest.get("summary", ""),
        "created_at": manifest.get("created_at", ""),
        "changes": changes,
        "todos": todos,
        "skipped": manifest.get("skipped", []),
        "warnings": manifest.get("warnings", []),
    }


def start_manual(rid: str) -> dict:
    d = _dir(rid)
    if not (d / "manifest.json").exists():
        _save_json(d / "manifest.json", empty_manifest(rid, "manual"))
    return get(rid)


def save_change(rid: str, path: str, working: str | None, status: str | None) -> None:
    d = _dir(rid)
    if working is not None:
        target = (d / "edits" / path).resolve()
        if d not in target.parents:
            raise ReviewError("Invalid path")
        target.parent.mkdir(parents=True, exist_ok=True)
        proposed = _text(d / "files" / path)
        if working.replace("\r\n", "\n") == proposed:
            target.unlink(missing_ok=True)
        else:
            target.write_text(working, "utf-8")
    if status is not None:
        if status not in ("pending", "accepted", "rejected"):
            raise ReviewError("Unknown status")
        state = _load_json(d / "state.json", {"changes": {}, "todos": {}})
        state["changes"].setdefault(path, {})["status"] = status
        _save_json(d / "state.json", state)


def save_todo(rid: str, index: int, fields: dict) -> None:
    d = _dir(rid)
    state = _load_json(d / "state.json", {"changes": {}, "todos": {}})
    t = state["todos"].setdefault(str(index), {})
    for k in ("text", "due", "include"):
        if k in fields:
            t[k] = fields[k]
    _save_json(d / "state.json", state)


def add_file(rid: str, path: str) -> None:
    """Pull any note into the review so the user can edit it alongside the agent's proposals."""
    d = _dir(rid)
    path = path.replace("\\", "/").lstrip("/")
    if not path.lower().endswith((".md", ".txt")):
        path += ".md"
    kb.resolve(path)
    manifest = _load_json(d / "manifest.json", None) or empty_manifest(rid, "manual")
    if any(c["path"] == path for c in manifest["changes"]):
        return
    current = _current(path)
    if current is None:
        current = _new_note_text(path)
        action, summary = "create", "New note added by you"
    else:
        action, summary = "update", "Added by you"
    f = d / "files" / path
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(current, "utf-8")
    manifest["changes"].append({"path": path, "action": action, "summary": summary, "sources": [], "origin": "user"})
    _save_json(d / "manifest.json", manifest)


def remove_file(rid: str, path: str) -> None:
    d = _dir(rid)
    manifest = _load_json(d / "manifest.json", None)
    if manifest is None:
        return
    manifest["changes"] = [c for c in manifest["changes"] if c["path"] != path]
    _save_json(d / "manifest.json", manifest)
    for sub in ("files", "edits"):
        (d / sub / path).unlink(missing_ok=True)


def _new_note_text(path: str) -> str:
    name = Path(path).stem
    today = datetime.now().strftime("%d/%m/%Y")
    tpl = _current("Template.md")
    if not tpl:
        return f"_Last updated: {today}_\n# {name}\n\n"
    lines = tpl.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("_Last updated"):
            lines[i] = f"_Last updated: {today}_"
        elif line.startswith("# "):
            lines[i] = f"# {name}"
            break
    return "\n".join(lines)


def discard(rid: str) -> None:
    d = _dir(rid)
    if d.exists():
        shutil.rmtree(d)


# ---------- apply ----------

def _todo_line(t: dict) -> str:
    line = f"- [ ] {t['text'].strip()}"
    if t.get("due"):
        line += f" @due({t['due']})"
    return line


def apply(rid: str, force: bool = False) -> dict:
    review = get(rid)
    changes = review["changes"]
    pending = [c["path"] for c in changes if c["status"] == "pending"]
    if pending:
        raise ReviewError("Some files still need a decision", {"pending": pending})
    # Accepted notes whose final text equals the current note change nothing; leave them out.
    accepted = [c for c in changes if c["status"] == "accepted"
                and not (c["action"] != "create" and c["working"] == c["original"])]
    stale = [c["path"] for c in accepted if c["stale"]]
    if stale and not force:
        raise ReviewError("These notes changed after the proposal was made", {"stale": stale})
    todos = [t for t in review["todos"] if t["include"] and t["text"].strip()]

    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    archive = KB / "Archive"

    # 1. Backup: every note outside Archive/, same layout as the existing backups.
    backup_rel = f"Backups/{ts}.zip"
    (archive / "Backups").mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive / backup_rel, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, p in kb.text_files(include_archive=False):
            z.write(p, rel)

    # 2. Write accepted notes.
    for c in accepted:
        kb.write(c["path"], c["working"])

    # 3. To-dos.
    if todos:
        existing = _current(TODO) or "# To-do\n"
        if not existing.endswith("\n"):
            existing += "\n"
        kb.write(TODO, existing + "\n".join(_todo_line(t) for t in todos) + "\n")

    # 4. Proposal log.
    capture = review["capture"] or ""
    def mark(c):
        if c["status"] == "accepted" and c not in accepted:
            return "Approved, no changes."
        if c["status"] == "rejected":
            return "Rejected."
        return "Approved (edited by user)." if c["edited"] else "Approved."
    lines = [f"# Proposal log {ts}", "", f"Source: {capture}", f"Reviewed in Jarvis; proposal by {review['agent'] or 'unknown'}.", ""]
    if review["summary"]:
        lines += [review["summary"], ""]
    lines += ["## Files"]
    def sentence(s):
        s = (s or "").strip()
        return s if not s or s[-1] in ".!?" else s + "."
    lines += [f"- {c['path']} {c['action'].upper()}: {sentence(c['summary'])} {mark(c)}" for c in changes] or ["- none"]
    if review["todos"]:
        lines += ["", "## To-dos"]
        lines += [f"- {t['text']}{' (due ' + t['due'] + ')' if t.get('due') else ''}. {'Added.' if t['include'] else 'Rejected.'}" for t in review["todos"]]
    if review["skipped"]:
        lines += ["", "## Not stored"]
        lines += [f"- {s.get('what', s) if isinstance(s, dict) else s}: {s.get('why', '') if isinstance(s, dict) else ''}" for s in review["skipped"]]
    proposal_rel = f"Proposals/{ts}.md"
    kb.write(f"Archive/{proposal_rel}", "\n".join(lines) + "\n")

    # 5. Change log, in the existing format.
    def short(p):
        return p[:-3] if p.endswith(".md") else p
    created = [short(c["path"]) for c in accepted if c["action"] == "create"]
    updated = [short(c["path"]) for c in accepted if c["action"] != "create"]
    rejected = [short(c["path"]) for c in changes if c["status"] == "rejected"]
    entry = [f"## {stamp}", f"- Backup: {backup_rel}; proposal log: [{proposal_rel}]({proposal_rel})"]
    if capture:
        entry.append(f"- Source: {capture}")
    if created:
        entry.append(f"- Created: {', '.join(created)}")
    if updated:
        entry.append(f"- Updated: {', '.join(updated)}")
    if todos:
        entry.append(f"- To-dos added: {len(todos)}")
    if rejected:
        entry.append(f"- Rejected: {', '.join(rejected)}")
    log_rel = "Archive/ChangeLog.md"
    log = _current(log_rel) or "# KB Change Log\n"
    kb.write(log_rel, log.rstrip("\n") + "\n\n" + "\n".join(entry) + "\n")

    # 6. Archive the capture.
    if capture and kb.resolve(capture).exists():
        dest = archive / "ProcessingBay" / Path(capture).name
        n = 1
        while dest.exists():
            dest = dest.with_name(f"{Path(capture).stem} ({n}){Path(capture).suffix}")
            n += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(kb.resolve(capture)), dest)

    # 7. Clear staging.
    discard(rid)
    return {
        "backup": f"Archive/{backup_rel}",
        "proposal_log": f"Archive/{proposal_rel}",
        "written": [c["path"] for c in accepted],
        "todos": len(todos),
    }
