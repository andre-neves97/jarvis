"""Loads jarvis.config.json (one per machine) and resolves the knowledge base path."""
import json
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("JARVIS_CONFIG") or APP_DIR / "jarvis.config.json")

DEFAULTS = {
    "kb_path": "../Knowledge Base",
    # A built-in preset ("claude", "copilot"; see agent.PRESETS), any name of your own
    # together with "agent_command", or "none" for manual review only.
    "agent": "claude",
    "agent_command": None,  # any CLI agent, e.g. ["my-agent", "run", "{prompt}"]
    "agent_label": None,    # name shown in the UI, e.g. "Gemini"; defaults to the preset's label
    "host": "127.0.0.1",
    "port": 8765,
    "inbox_dir": "ProcessingBay",
    "todo_file": "todo.md",
}


def _load() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text("utf-8")))
    # Environment overrides, handy for testing against a copy of the knowledge base.
    if os.environ.get("JARVIS_KB"):
        cfg["kb_path"] = os.environ["JARVIS_KB"]
    if os.environ.get("JARVIS_PORT"):
        cfg["port"] = int(os.environ["JARVIS_PORT"])
    if os.environ.get("JARVIS_AGENT"):
        cfg["agent"] = os.environ["JARVIS_AGENT"]
    kb = Path(cfg["kb_path"]).expanduser()
    if not kb.is_absolute():
        kb = (APP_DIR / kb).resolve()
    cfg["kb_root"] = kb
    return cfg


CONFIG = _load()
KB: Path = CONFIG["kb_root"]
STAGING: Path = KB / ".jarvis" / "staging"
