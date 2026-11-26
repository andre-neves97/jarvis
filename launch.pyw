"""Desktop launcher: starts the Jarvis server quietly if needed, then opens it in its own app window."""
import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

APP = Path(__file__).resolve().parent
CONFIG = APP / "jarvis.config.json"


def port() -> int:
    try:
        return int(json.loads(CONFIG.read_text("utf-8")).get("port", 8765))
    except Exception:
        return 8765


URL = f"http://127.0.0.1:{port()}"


def alive() -> bool:
    try:
        with urllib.request.urlopen(URL + "/api/info", timeout=1):
            return True
    except Exception:
        return False


def info() -> dict | None:
    try:
        with urllib.request.urlopen(URL + "/api/info", timeout=1) as r:
            return json.load(r)
    except Exception:
        return None


def stale(i: dict) -> bool:
    """True if the running server started before the app's code was last changed."""
    newest = max(p.stat().st_mtime for p in [*(APP / "backend").glob("*.py"), APP / "frontend/dist/index.html"] if p.exists())
    return i.get("started", 0) < newest


def stop_server() -> None:
    try:
        req = urllib.request.Request(URL + "/api/shutdown", method="POST")
        urllib.request.urlopen(req, timeout=2).close()
    except Exception:
        pass
    for _ in range(40):
        if not alive():
            return
        time.sleep(0.25)


def message(text: str) -> None:
    ctypes.windll.user32.MessageBoxW(None, text, "Jarvis", 0x10)


def window_url() -> str:
    # Edge caches a page's icon by its address and reuses it for the window and taskbar,
    # so tag the address with the icon's version: a new icon then means a fresh address.
    icon = APP / "frontend/src/icon-32.png"
    return f"{URL}/?icon={int(icon.stat().st_mtime) if icon.exists() else 0}"


def open_window() -> None:
    # Edge (built into Windows) or Chrome in app mode: a window without tabs or address bar.
    url = window_url()
    candidates = [
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    for exe in candidates:
        if exe.is_file():
            subprocess.Popen([str(exe), f"--app={url}"])
            return
    webbrowser.open(url)


def main() -> None:
    running = info()
    if running and stale(running):
        stop_server()  # Jarvis was updated since this server started: restart it on the new code
    if not alive():
        if not (APP / "frontend/dist/index.html").exists():
            return message("Jarvis isn't set up yet. Run start.bat in the app folder once, then use this icon.")
        log = open(APP / "jarvis.log", "a", encoding="utf-8")
        subprocess.Popen(
            [sys.executable, str(APP / "backend/server.py")], cwd=APP / "backend",
            stdout=log, stderr=log, stdin=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS,
        )
        for _ in range(60):
            if alive():
                break
            time.sleep(0.25)
        else:
            return message(f"Jarvis didn't start. Details are in:\n{APP / 'jarvis.log'}")
    open_window()


main()
