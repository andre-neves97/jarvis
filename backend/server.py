"""Jarvis local server. Run: python server.py  (serves the built UI on http://127.0.0.1:8765)."""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

import agent
import kb
import review
from config import APP_DIR, CONFIG, KB

@asynccontextmanager
async def lifespan(_app):
    global _loop
    _loop = asyncio.get_running_loop()
    obs = Observer()
    obs.schedule(_Handler(), str(KB), recursive=True)
    obs.daemon = True
    obs.start()
    yield
    obs.stop()


app = FastAPI(title="Jarvis", lifespan=lifespan)
STARTED = time.time()  # the launcher compares this with the code's mtime to restart stale servers


@app.exception_handler(kb.OutsideKB)
async def _outside(_, exc):
    return JSONResponse({"detail": "Path is outside the knowledge base"}, status_code=400)


@app.exception_handler(review.ReviewError)
async def _review_err(_, exc: review.ReviewError):
    return JSONResponse({"detail": str(exc), **exc.detail}, status_code=409)


# ---------- files ----------

class WriteBody(BaseModel):
    path: str
    content: str
    base_sha: str | None = None
    force: bool = False


@app.get("/api/info")
def info():
    return {"kb": str(KB), "kb_name": KB.name, "agent": agent.name(), "agent_label": agent.label(),
            "agent_available": agent.available(), "todo_file": CONFIG["todo_file"], "started": STARTED}


@app.post("/api/shutdown")
def shutdown(request: Request):
    """Lets the desktop launcher replace an outdated server. Local callers only."""
    if request.client and request.client.host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Local only")
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"ok": True}


@app.get("/api/tree")
def tree():
    return kb.tree()


@app.get("/api/file")
def read_file(path: str):
    p = kb.resolve(path)
    if not p.is_file():
        raise HTTPException(404, "File not found")
    return kb.read(path)


@app.get("/api/raw")
def raw_file(path: str):
    p = kb.resolve(path)
    if not p.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(p)


@app.put("/api/file")
def write_file(body: WriteBody):
    try:
        return kb.write(body.path, body.content, body.base_sha, body.force)
    except kb.Conflict as c:
        return JSONResponse({"detail": "conflict", "current": c.current}, status_code=409)


class NewBody(BaseModel):
    path: str


@app.post("/api/file/new")
def new_file(body: NewBody):
    path = _clean_new_path(body.path)
    if not path.lower().endswith((".md", ".txt")):
        path += ".md"
    p = kb.resolve(path)
    if p.exists():
        raise HTTPException(409, "A note with that name already exists")
    if p.parent.exists() and not p.parent.is_dir():
        raise HTTPException(409, "The parent folder is a file")
    return kb.write(path, review._new_note_text(path))


@app.post("/api/folder/new")
def new_folder(body: NewBody):
    path = _clean_new_path(body.path)
    p = kb.resolve(path)
    if p == KB:
        raise HTTPException(400, "Type a name for the folder")
    if p.exists():
        raise HTTPException(409, "A folder or file with that name already exists")
    p.mkdir(parents=True)
    return {"path": kb.relpath(p)}


_BAD_CHARS = set('<>:"|?*')
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def _clean_new_path(raw: str) -> str:
    """Normalize a user-typed KB path and reject names Windows/OneDrive can't hold."""
    parts = [x.strip() for x in raw.strip().replace("\\", "/").split("/") if x.strip()]
    if not parts:
        raise HTTPException(400, "Type a name")
    for part in parts:
        if part in (".", ".."):
            raise HTTPException(400, "Names can't be '.' or '..'")
        if part.startswith("."):
            raise HTTPException(400, "Names can't start with a dot (Jarvis hides those)")
        if bad := sorted(_BAD_CHARS.intersection(part)):
            raise HTTPException(400, f"Names can't contain {' '.join(bad)}")
        if part.endswith("."):
            raise HTTPException(400, "Names can't end with a dot")
        if part.split(".")[0].lower() in _RESERVED:
            raise HTTPException(400, f"'{part}' is a reserved name on Windows")
    return "/".join(parts)


@app.get("/api/backlinks")
def backlinks(path: str):
    return kb.backlinks(path)


@app.get("/api/search")
def search(q: str):
    return kb.search(q)


# ---------- inbox & review ----------

@app.get("/api/inbox")
def inbox():
    return review.inbox(agent.running(), agent.queued())


@app.post("/api/inbox/process-all")
def process_all():
    new = [i["id"] for i in review.inbox(agent.running(), agent.queued()) if i["status"] == "new"]
    try:
        return {"queued": agent.enqueue(new)}
    except RuntimeError as e:
        raise HTTPException(400, str(e))


@app.post("/api/inbox/{rid}/process")
def process(rid: str):
    try:
        agent.start(rid)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.get("/api/inbox/{rid}/agent")
def agent_status(rid: str):
    return agent.status(rid)


@app.post("/api/review/{rid}/manual")
def start_manual(rid: str):
    return review.start_manual(rid)


@app.get("/api/review/{rid}")
def get_review(rid: str):
    return review.get(rid)


class ChangeBody(BaseModel):
    path: str
    working: str | None = None
    status: str | None = None


@app.put("/api/review/{rid}/change")
def save_change(rid: str, body: ChangeBody):
    review.save_change(rid, body.path, body.working, body.status)
    return {"ok": True}


class TodoBody(BaseModel):
    index: int
    text: str | None = None
    due: str | None = None
    include: bool | None = None


@app.put("/api/review/{rid}/todo")
def save_todo(rid: str, body: TodoBody):
    review.save_todo(rid, body.index, body.model_dump(exclude_unset=True))
    return {"ok": True}


@app.post("/api/review/{rid}/file")
def add_file(rid: str, body: NewBody):
    review.add_file(rid, body.path)
    return review.get(rid)


@app.delete("/api/review/{rid}/file")
def remove_file(rid: str, path: str):
    review.remove_file(rid, path)
    return review.get(rid)


class ApplyBody(BaseModel):
    force: bool = False


@app.post("/api/review/{rid}/apply")
def apply(rid: str, body: ApplyBody):
    return review.apply(rid, body.force)


@app.delete("/api/review/{rid}")
def discard(rid: str):
    review.discard(rid)
    return {"ok": True}


# ---------- live file events (server-sent events) ----------

_subscribers: set[asyncio.Queue] = set()
_loop: asyncio.AbstractEventLoop | None = None


class _Handler(FileSystemEventHandler):
    def on_any_event(self, event):
        if event.is_directory and event.event_type == "modified":
            return
        paths = [event.src_path] + ([event.dest_path] if getattr(event, "dest_path", "") else [])
        for raw in paths:
            try:
                rel = Path(raw).resolve().relative_to(KB).as_posix()
            except ValueError:
                continue
            if Path(rel).name.startswith(".jarvis-"):
                continue  # our own temp files
            msg = json.dumps({"type": event.event_type, "path": rel})
            if _loop:
                for q in list(_subscribers):
                    _loop.call_soon_threadsafe(q.put_nowait, msg)


@app.get("/api/events")
async def events(request: Request):
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while not await request.is_disconnected():
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            _subscribers.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream")


# ---------- UI ----------

DIST = APP_DIR / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        # Always revalidate the page so a rebuilt UI shows up on the next open;
        # the hashed files under /assets can stay cached.
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    print(f"Jarvis: knowledge base {KB}")
    print(f"Jarvis: agent {agent.label()} ({'found' if agent.available() else 'not found'})")
    print(f"Jarvis: open http://{CONFIG['host']}:{CONFIG['port']}")
    uvicorn.run(app, host=CONFIG["host"], port=CONFIG["port"], log_level="warning")
