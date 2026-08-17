"""Configuration loaded from a gitignored .env file beside this script."""

import json
import os
import re
from datetime import date as _date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
LABELS_PATH = ROOT / "course_labels.json"
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

TOKEN_EXPIRES = os.environ.get("CANVAS_TOKEN_EXPIRES", "").strip()

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


def token_days_left(today=None):
    """Days until the access token expires, or None if no date is configured.

    Negative once it has lapsed. A malformed date is reported rather than
    swallowed, since a silently-ignored expiry defeats the whole point.
    """
    if not TOKEN_EXPIRES:
        return None
    try:
        expires = _date.fromisoformat(TOKEN_EXPIRES)
    except ValueError:
        print(
            f"  warning: CANVAS_TOKEN_EXPIRES={TOKEN_EXPIRES!r} is not YYYY-MM-DD; "
            "no expiry reminder will be shown"
        )
        return None
    return (expires - (today or _date.today())).days


def course_allowed(name):
    lowered = (name or "").lower()
    if INCLUDE_COURSES:
        return any(term in lowered for term in INCLUDE_COURSES)
    return not any(term in lowered for term in EXCLUDE_COURSES)


# --- Course display names -------------------------------------------------
#
# District course names carry the student's whole schedule -- teacher surname
# and period number -- e.g. "ALG 1 HON - P2 - Surname". Publishing that to a
# public page identifies the student far more precisely than a grade does, so
# names are rewritten here before anything is written to data.json.


def _load_labels():
    if not LABELS_PATH.exists():
        return {}
    try:
        raw = json.loads(LABELS_PATH.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"  warning: could not read course_labels.json ({exc}); using raw names")
        return {}
    return {
        str(key).lower(): str(value)
        for key, value in raw.items()
        # "_"-prefixed keys are comments in the example file.
        if key and value and not str(key).startswith("_")
    }


COURSE_LABELS = _load_labels()

# " - P2 - ", ": PER: 6,7,8", "(Period 3)" and friends.
_PERIOD_RE = re.compile(
    r"[-–—:,(]?\s*\b(?:p|pd|per|period)\.?\s*\d+(?:\s*[,&/]\s*\d+)*\b\s*[-–—:,)]?",
    re.IGNORECASE,
)


def matched_label(name):
    """The configured label for a course, or None if nothing matches."""
    lowered = (name or "").lower()
    for key, label in COURSE_LABELS.items():
        if key in lowered:
            return label
    return None


def tidy_course(name):
    """Fallback for unmapped courses: at least drop the period markers."""
    cleaned = _PERIOD_RE.sub(" ", name or "")
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" -–—:,.")
    return cleaned or (name or "Course")


def course_label(name):
    return matched_label(name) or tidy_course(name)
