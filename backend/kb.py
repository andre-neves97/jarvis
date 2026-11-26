"""Safe file access to the knowledge base: read, write (keeping line endings), tree, links, search."""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
import threading
from pathlib import Path
from urllib.parse import unquote

from config import KB

TEXT_EXT = {".md", ".txt"}
SKIP_FILES = {"desktop.ini", "thumbs.db"}

# sha of the last content this app wrote per path, so file-watcher echoes
# and the agent safety net can tell our own writes from someone else's.
_own_writes: dict[str, str] = {}
_lock = threading.Lock()


class OutsideKB(ValueError):
    pass


class Conflict(Exception):
    def __init__(self, current: dict):
        self.current = current


def sha(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def resolve(rel: str) -> Path:
    p = (KB / rel).resolve()
    if p != KB and KB not in p.parents:
        raise OutsideKB(rel)
    return p


def relpath(p: Path) -> str:
    return p.resolve().relative_to(KB).as_posix()


def _decode(raw: bytes) -> str:
    text = raw.decode("utf-8-sig", errors="replace")
    return text.replace("\r\n", "\n")


def read_text(rel: str) -> str:
    return _decode(resolve(rel).read_bytes())


def read(rel: str) -> dict:
    p = resolve(rel)
    text = _decode(p.read_bytes())
    return {"path": rel, "content": text, "sha": sha(text), "mtime": p.stat().st_mtime}


def write(rel: str, content: str, base_sha: str | None = None, force: bool = False) -> dict:
    """Write normalized (\\n) text, keeping the file's existing BOM and line-ending style."""
    p = resolve(rel)
    content = content.replace("\r\n", "\n")
    with _lock:
        crlf, bom = False, False
        if p.exists():
            raw = p.read_bytes()
            current = _decode(raw)
            if base_sha and not force and sha(current) != base_sha:
                raise Conflict({"path": rel, "content": current, "sha": sha(current)})
            crlf = b"\r\n" in raw
            bom = raw.startswith(b"\xef\xbb\xbf")
        out = content.replace("\n", "\r\n") if crlf else content
        data = (b"\xef\xbb\xbf" if bom else b"") + out.encode("utf-8")
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".jarvis-", suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
        _own_writes[rel] = sha(content)
    return {"path": rel, "sha": sha(content), "mtime": p.stat().st_mtime}


def is_own_write(rel: str, content_sha: str) -> bool:
    return _own_writes.get(rel) == content_sha


def tree() -> list[dict]:
    items = []
    for root, dirs, files in os.walk(KB):
        dirs[:] = sorted((d for d in dirs if not d.startswith(".")), key=str.lower)
        r = Path(root)
        for d in dirs:
            items.append({"path": relpath(r / d), "type": "dir"})
        for f in sorted(files, key=str.lower):
            if f.lower() in SKIP_FILES or f.startswith("."):
                continue
            p = r / f
            items.append({"path": relpath(p), "type": "file", "ext": p.suffix.lower()})
    return items


def text_files(include_archive: bool = True):
    for root, dirs, files in os.walk(KB):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        r = Path(root)
        for f in files:
            p = r / f
            if p.suffix.lower() not in TEXT_EXT:
                continue
            rel = relpath(p)
            if not include_archive and rel.startswith("Archive/"):
                continue
            yield rel, p


LINK_RE = re.compile(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
WIKI_RE = re.compile(r"\[\[([^\]|#]+)")


def _resolve_link(from_rel: str, href: str) -> str | None:
    if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I) or href.startswith("#"):
        return None
    href = unquote(href.split("#")[0])
    if not href:
        return None
    base = Path(from_rel).parent
    parts: list[str] = []
    for part in (base / href).as_posix().split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
        else:
            parts.append(part)
    return "/".join(parts)


def backlinks(target: str) -> list[dict]:
    stem = Path(target).stem.lower()
    out = []
    for rel, p in text_files(include_archive=False):
        if rel == target:
            continue
        text = _decode(p.read_bytes())
        hit = any(_resolve_link(rel, m) == target for m in LINK_RE.findall(text))
        hit = hit or any(w.strip().lower() == stem for w in WIKI_RE.findall(text))
        if hit:
            out.append({"path": rel})
    return sorted(out, key=lambda x: x["path"].lower())


def search(q: str, limit: int = 40) -> list[dict]:
    q = q.strip()
    if not q:
        return []
    ql = q.lower()
    results = []
    for rel, p in text_files():
        text = _decode(p.read_bytes())
        name_hit = ql in Path(rel).stem.lower()
        snippets = []
        for i, line in enumerate(text.split("\n")):
            if ql in line.lower():
                snippets.append({"line": i + 1, "text": line.strip()[:220]})
                if len(snippets) >= 3:
                    break
        if name_hit or snippets:
            score = (0 if name_hit else 1, rel.startswith("Archive/"), rel.lower())
            results.append((score, {"path": rel, "snippets": snippets}))
    results.sort(key=lambda r: r[0])
    return [r[1] for r in results[:limit]]


def snapshot() -> dict[str, bytes]:
    """Raw bytes of every text file outside .jarvis, used as the agent safety net."""
    return {rel: p.read_bytes() for rel, p in text_files()}
