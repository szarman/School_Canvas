"""Configuration loaded from a gitignored .env file beside this script."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
DATA_PATH = ROOT / "docs" / "data.json"


def _load_env(path=ENV_PATH):
    """Minimal .env reader. Avoids a python-dotenv dependency."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        # Real environment variables win, so you can override for one run.
        os.environ.setdefault(key.strip(), value)


_load_env()


def _csv(name):
    raw = os.environ.get(name, "")
    return [part.strip().lower() for part in raw.split(",") if part.strip()]


BASE_URL = os.environ.get("CANVAS_BASE_URL", "").rstrip("/")
TOKEN = os.environ.get("CANVAS_TOKEN", "").strip()
USERNAME = os.environ.get("CANVAS_USERNAME", "").strip()
PASSWORD = os.environ.get("CANVAS_PASSWORD", "").strip()

INCLUDE_COURSES = _csv("INCLUDE_COURSES")
EXCLUDE_COURSES = _csv("EXCLUDE_COURSES")
GRADED_HISTORY_DAYS = int(os.environ.get("GRADED_HISTORY_DAYS", "45"))
INCLUDE_LINKS = os.environ.get("INCLUDE_LINKS", "1").strip() not in ("0", "false", "no")


def validate():
    if not BASE_URL:
        raise SystemExit("CANVAS_BASE_URL is not set. Copy .env.example to .env and fill it in.")
    if not TOKEN and not (USERNAME and PASSWORD):
        raise SystemExit(
            "No credentials. Set CANVAS_TOKEN, or CANVAS_USERNAME + CANVAS_PASSWORD, in .env"
        )


def course_allowed(name):
    lowered = (name or "").lower()
    if INCLUDE_COURSES:
        return any(term in lowered for term in INCLUDE_COURSES)
    return not any(term in lowered for term in EXCLUDE_COURSES)
