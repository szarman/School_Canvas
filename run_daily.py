"""Nightly entry point: scrape Canvas, then publish the result.

Task Scheduler runs this at 11:00 PM. Everything printed also lands in
scrape.log so a failed unattended run leaves a trace.
"""

import sys
import traceback
from datetime import datetime

import config
import publish
import scrape

LOG_PATH = config.ROOT / "scrape.log"
MAX_LOG_BYTES = 512_000


class Tee:
    """Write to the console and the log file at once."""

    def __init__(self, stream, handle):
        self.stream = stream
        self.handle = handle

    def write(self, text):
        self.stream.write(text)
        self.handle.write(text)

    def flush(self):
        self.stream.flush()
        self.handle.flush()


def main():
    if LOG_PATH.exists() and LOG_PATH.stat().st_size > MAX_LOG_BYTES:
        LOG_PATH.write_text(
            "".join(LOG_PATH.read_text(encoding="utf-8").splitlines(keepends=True)[-500:]),
            encoding="utf-8",
        )

    with LOG_PATH.open("a", encoding="utf-8") as handle:
        original = sys.stdout
        sys.stdout = Tee(original, handle)
        try:
            print(f"\n=== {datetime.now():%Y-%m-%d %H:%M:%S} ===")
            scrape.main()
            return publish.main()
        except SystemExit as exc:
            print(f"Stopped: {exc}")
            return 1
        except Exception:
            traceback.print_exc(file=sys.stdout)
            return 1
        finally:
            sys.stdout = original


if __name__ == "__main__":
    sys.exit(main())
