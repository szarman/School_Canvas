"""Commit docs/data.json and push it to GitHub Pages.

Only the docs/ folder is ever staged, so an accidentally-untracked secret
elsewhere in the working directory cannot ride along.
"""

import hashlib
import re
import subprocess
import sys

import config

ASSETS = ("app.js", "styles.css")


def git(*args, check=True):
    result = subprocess.run(
        ["git", *args],
        cwd=config.ROOT,
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed:\n{result.stderr.strip()}")
    return result


def stamp_assets():
    """Version app.js and styles.css by content hash.

    GitHub Pages serves everything with max-age=600, so a browser can pair a
    freshly-fetched index.html with a ten-minute-old script. New markup driven
    by old code fails in confusing ways -- a button that does nothing -- so the
    URL changes whenever the file does, which retires the cached copy.
    """
    index = config.ROOT / "docs" / "index.html"
    if not index.exists():
        return

    html = original = index.read_text(encoding="utf-8")
    for asset in ASSETS:
        path = config.ROOT / "docs" / asset
        if not path.exists():
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:10]
        html = re.sub(
            rf'({re.escape(asset)})(\?v=[0-9a-f]+)?"',
            rf'\1?v={digest}"',
            html,
        )

    if html != original:
        index.write_text(html, encoding="utf-8")
        print("Stamped asset versions.")


def has_remote():
    return bool(git("remote", check=False).stdout.strip())


def main():
    if not (config.ROOT / ".git").exists():
        print("Not a git repository yet — skipping publish. See README step 4.")
        return 0

    stamp_assets()
    git("add", "--", "docs")

    staged = git("diff", "--cached", "--quiet", "--", "docs", check=False)
    if staged.returncode == 0:
        print("No changes to publish.")
        return 0

    stamp = config.DATA_PATH.exists() and "assignment data" or "site"
    git("commit", "-m", f"Update {stamp}")
    print("Committed.")

    if not has_remote():
        print("No git remote configured — committed locally only. See README step 4.")
        return 0

    push = git("push", check=False)
    if push.returncode != 0:
        print(f"Push failed:\n{push.stderr.strip()}")
        return 1

    print("Pushed to GitHub.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
