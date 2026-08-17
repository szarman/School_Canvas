# Homework Board

Pulls assignments, due dates, submission status and grades from Canvas once a
night, and publishes them as a static status board on GitHub Pages.

Work lands in one of five buckets — **Overdue & missing**, **Due this week**,
**Coming up**, **Awaiting grading**, **Graded** — and each item has two
checkboxes: *Done* (you finished it) and *Turned in*.

Canvas is the source of truth. Once Canvas reports a real submission, the
*Turned in* box is checked and locked automatically, and any manual mark you
set earlier is retired. The manual boxes are there for the things Canvas cannot
see: paper handouts, work done in class, and work you've finished but not
submitted yet.

## What gets published

`docs/data.json` carries **no personal information** — no student name, login,
email, or Canvas user ID. Only course names, assignment titles, dates, points
and scores. Set `INCLUDE_LINKS=0` in `.env` to also strip the click-through
links (and with them the course/assignment IDs).

Note that a GitHub Pages site is reachable by anyone who knows the URL, on
every plan. Grades will be visible to anyone who finds it.

## Setup

### 1. Install dependencies

```bash
python -m pip install -r requirements.txt
```

### 2. Configure credentials

```bash
copy .env.example .env
```

Then edit `.env`. Two ways to authenticate, tried in this order:

**Access token (preferred).** In Canvas go to **Account → Settings**, scroll to
*Approved Integrations*, and click **+ New Access Token**. Paste it into
`CANVAS_TOKEN`. No browser needed, and it runs in a couple of seconds.

**Browser login (fallback).** Many K‑12 districts hide that button for student
accounts. If it isn't there, leave `CANVAS_TOKEN` blank and fill in
`CANVAS_USERNAME` and `CANVAS_PASSWORD` instead. Selenium signs in headlessly
and reads the same API through the session. Requires Chrome.

If a token is set but rejected, the script falls back to the browser login on
its own.

`.env` is gitignored and never leaves your machine.

### 3. Test the pull

```bash
python scrape.py
```

This writes `docs/data.json`. Preview the board locally with:

```bash
python -m http.server 8765 --directory docs
```

and open <http://localhost:8765>. (Opening `index.html` directly from disk
won't work — the browser blocks `fetch` on `file://`.)

### 4. Put it on GitHub

Create a **new empty public repository** on github.com, then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git branch -M main
git push -u origin main
```

In the repo, go to **Settings → Pages** and set the source to **Deploy from a
branch**, branch `main`, folder **`/docs`**. The board appears at
`https://YOUR-USERNAME.github.io/YOUR-REPO/` a minute or so later.

### 5. Schedule the nightly pull

```bash
powershell -ExecutionPolicy Bypass -File .\install_task.ps1
```

Registers a task named **Canvas Homework Board** that runs at 11:00 PM daily as
you, only while you're logged on, so no password is stored with the task. If
the PC was off, it catches up at the next login.

```bash
powershell -ExecutionPolicy Bypass -File .\install_task.ps1 -At 22:00
```

changes the time; `-Remove` unregisters it.

## Running it by hand

```bash
python run_daily.py
```

Scrapes, commits `docs/`, and pushes. `scrape.py` alone updates the data
without publishing. Output from every run — scheduled or manual — is appended
to `scrape.log`.

## Files

| File | Purpose |
| --- | --- |
| `scrape.py` | Canvas → `docs/data.json` |
| `canvas_client.py` | Token and browser-login transports for the Canvas API |
| `config.py` | Reads `.env` |
| `publish.py` | Commits and pushes `docs/` |
| `run_daily.py` | Nightly entry point; scrape + publish + log |
| `install_task.ps1` | Registers/removes the 11 PM scheduled task |
| `docs/` | The published site |

## Options in `.env`

| Setting | Default | Meaning |
| --- | --- | --- |
| `INCLUDE_COURSES` | *(blank)* | Comma-separated name substrings to keep. Wins over `EXCLUDE_COURSES`. |
| `EXCLUDE_COURSES` | *(blank)* | Name substrings to drop, e.g. `homeroom,advisory`. |
| `GRADED_HISTORY_DAYS` | `45` | How far back graded work stays on the board. |
| `INCLUDE_LINKS` | `1` | Set to `0` to omit assignment links and IDs. |

Courses are discovered from active enrollments each run, so a new school year
picks up new classes with no code changes.

## Notes

- `docs/data.json` currently holds **sample data** so the page renders before
  your first real pull. `python scrape.py` overwrites it.
- The *Done* / *Turned in* checkmarks live in the browser's `localStorage`, so
  they're per-device and don't sync between a phone and a laptop. **Settings →
  Export / Import checkmarks** moves them across.
- The old `Get Assignments.py`, `HW scraper.py` and `Canvas_Assignments.xlsx`
  are gitignored and are not part of this tool. `Get Assignments.py` contains a
  plaintext Canvas password — see below.

## Security

The original `Get Assignments.py` had the Canvas username and password hardcoded
on lines 12–13, sitting in a OneDrive-synced folder. That file is gitignored so
it can't reach the public repo, but **that password should be changed**, and the
new one kept only in `.env`.
