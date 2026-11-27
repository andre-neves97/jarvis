"""Loads the app's .env and jarvis.config.json (one per machine) and resolves the knowledge base path."""
import json
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = APP_DIR / ".env"


def _read_env(path: Path) -> dict:
    """Parses KEY=value lines from the app's .env."""
    env = {}
    if not path.exists():
        return env
    for line in path.read_text("utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip().removeprefix("export ").strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and value:
            env[key] = value
    return env


ENV = _read_env(ENV_PATH)
# Other settings in .env (JARVIS_PORT, JARVIS_AGENT, ...) apply unless the real environment sets them.
for _key, _value in ENV.items():
    os.environ.setdefault(_key, _value)

CONFIG_PATH = Path(os.environ.get("JARVIS_CONFIG") or APP_DIR / "jarvis.config.json")

DEFAULTS = {
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
    if os.environ.get("JARVIS_PORT"):
        cfg["port"] = int(os.environ["JARVIS_PORT"])
    if os.environ.get("JARVIS_AGENT"):
        cfg["agent"] = os.environ["JARVIS_AGENT"]
    # The knowledge base folder is only ever taken from JARVIS_KB in the app's .env:
    # no default, no kb_path in jarvis.config.json, no environment variable.
    cfg.pop("kb_path", None)
    if not ENV.get("JARVIS_KB"):
        raise SystemExit(
            f"No knowledge base folder set. Add this line to {ENV_PATH}:\n"
            "JARVIS_KB=C:/path/to/your/Knowledge Base"
        )
    kb = Path(ENV["JARVIS_KB"]).expanduser()
    if not kb.is_absolute():
        kb = (APP_DIR / kb).resolve()
    if not kb.is_dir():
        raise SystemExit(f"Knowledge base folder not found: {kb}\nCheck JARVIS_KB in {ENV_PATH}")
    cfg["kb_root"] = kb
    return cfg


CONFIG = _load()
KB: Path = CONFIG["kb_root"]
STAGING: Path = KB / ".jarvis" / "staging"
