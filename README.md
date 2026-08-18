# Homework Board

Pulls assignments, due dates, submission status and grades from Canvas once a
night, and publishes them as a static status board on GitHub Pages.

There are two views. **Homework** sorts work into five buckets — Overdue &
missing, Due this week, Coming up, Awaiting grading, Graded — each with two
checkboxes: *Done* (you finished it) and *Turned in*. **Grades** shows the
per-course percentage and letter, points earned against points graded, and how
many points are still outstanding, with a per-assignment breakdown.

Anything Canvas has already received — submitted, graded or excused — shows
both checkboxes ticked and locked, since a manual mark there could only
contradict Canvas.

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

Course names get rewritten first. District names embed the teacher surname and
period number — `ALG 1 HON - P2 - Surname`, `IAPS: C.SURNAME: PER: 6,7,8` —
which together amount to the student's full schedule and identify them far more
precisely than a grade does. `course_labels.json` maps those to clean labels
(`Algebra 1 Honors`, `IAPS`) before anything is written.

That file is **gitignored**, since it holds the very names being stripped. Copy
`course_labels.example.json` to `course_labels.json` and edit it. Keys are
case-insensitive substrings of the Canvas course name, first match wins.

Anything unmapped falls back to the raw name with period markers removed —
which does *not* remove a teacher surname — and `scrape.py` prints a warning
naming the course so you can add it.

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

### Parent and observer accounts

A parent account works, but needs different API calls, which the scraper
detects and handles automatically. This matters more than it sounds: an
observer token *appears* to work: courses come back normally, and the failure
is silent and plausible. Every assignment reads as unsubmitted and every course
as ungraded, because Canvas is faithfully reporting that the **parent** has
submitted nothing and is enrolled for no grade.

So the scraper checks `/users/self/observees` first. When the token observes a
student it names them explicitly — `include[]=observed_users` for grades, and
the per-student submissions endpoint instead of `assignments?include[]=
submission` — and prints `observer account; reading student <id>` so you can
see which path ran.

Set `CANVAS_STUDENT_ID` only if the account observes more than one student; the
script lists the IDs and stops if it needs you to choose.

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

The remote is already wired to <https://github.com/szarman/School_Canvas>:

```bash
git push -u origin main
```

Then in the repo go to **Settings → Pages**, set the source to **Deploy from a
branch**, branch `main`, folder **`/docs`**, and save. The board appears at
<https://szarman.github.io/School_Canvas/> a minute or so later.

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
| `config.py` | Reads `.env` and `course_labels.json` |
| `course_labels.json` | District course name → public label (gitignored) |
| `publish.py` | Commits and pushes `docs/` |
| `run_daily.py` | Nightly entry point; scrape + publish + log |
| `install_task.ps1` | Registers/removes the 11 PM scheduled task |
| `docs/` | The published site |
| `worker/` | Cloudflare Worker for cross-device checkmark sync |

## Options in `.env`

| Setting | Default | Meaning |
| --- | --- | --- |
| `INCLUDE_COURSES` | *(blank)* | Comma-separated name substrings to keep. Wins over `EXCLUDE_COURSES`. |
| `EXCLUDE_COURSES` | *(blank)* | Name substrings to drop, e.g. `homeroom,advisory`. |
| `GRADED_HISTORY_DAYS` | `45` | How far back graded work stays on the board. |
| `INCLUDE_LINKS` | `1` | Set to `0` to omit assignment links and IDs. |
| `CANVAS_TOKEN_EXPIRES` | *(blank)* | Token expiry date, `YYYY-MM-DD`. Drives the countdown banner. |
| `CANVAS_STUDENT_ID` | *(blank)* | Observer accounts watching more than one student. Auto-detected otherwise. |
| `SYNC_URL` | *(blank)* | Cloudflare Worker URL for cross-device checkmarks. See [worker/README.md](worker/README.md). |

Note `GRADED_HISTORY_DAYS` trims old graded work off the board, which also
trims it out of the Grades view's points tally. The headline percentage is
unaffected — that comes from Canvas and reflects the whole term — but raise
this if you want the points breakdown to cover more than the last 45 days.

## When the token expires

Canvas access tokens can be issued with an expiry date. Put that date in
`CANVAS_TOKEN_EXPIRES` and the board shows a countdown banner for the last 30
days, turning red in the final week, then switching to "the board has stopped
updating" once it lapses. `scrape.py` prints the same warning to `scrape.log`.

The countdown is computed in the browser from the date, not from a number baked
into `data.json` — because the failure it warns about is exactly the one that
stops `data.json` from updating. A stored count would freeze at "expires in
1 day" forever.

To renew: Canvas → **Account → Settings → + New Access Token**, then update
both `CANVAS_TOKEN` and `CANVAS_TOKEN_EXPIRES` in `.env`.

Courses are discovered from active enrollments each run, so a new school year
picks up new classes with no code changes.

## Notes

- `docs/data.json` currently holds **sample data** so the page renders before
  your first real pull. `python scrape.py` overwrites it.
- The *Done* / *Turned in* checkmarks live in the browser's `localStorage`. On
  their own they are per-device; set up `worker/` for a Cloudflare Worker that
  syncs them across a phone and a laptop. **Settings → Export / Import
  checkmarks** still works either way as a manual backup.
- The old `Get Assignments.py`, `HW scraper.py` and `Canvas_Assignments.xlsx`
  are gitignored and are not part of this tool. `Get Assignments.py` contains a
  plaintext Canvas password — see below.

## Security

The original `Get Assignments.py` had the Canvas username and password hardcoded
on lines 12–13, sitting in a OneDrive-synced folder. That file is gitignored so
it can't reach the public repo, but **that password should be changed**, and the
new one kept only in `.env`.
