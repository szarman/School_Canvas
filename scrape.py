"""Pull assignments and grades from Canvas into docs/data.json.

The output is deliberately free of personal information -- no student name,
login, email, or user ID -- because it is published to a public GitHub Pages
site. Course names, assignment titles, dates and scores are all that ship.
"""

import json
import sys
from datetime import datetime, timedelta, timezone

import canvas_client
import config

# How far back past-due-and-unsubmitted work stays on the board.
MISSING_HISTORY_DAYS = 120


def parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def resolve_student(client):
    """Return the observed student's ID, or None for a student's own token.

    A parent/observer token sees the courses but has no submissions and no
    grades of its own, so asking Canvas for "my" work returns an empty shell:
    every assignment reads unsubmitted and every course ungraded. The student
    has to be named explicitly on each call instead.
    """
    try:
        observees = client.get_all("/api/v1/users/self/observees")
    except Exception:
        return None  # student tokens are not allowed to ask, which is answer enough

    if not observees:
        return None

    if config.STUDENT_ID:
        if not any(str(o.get("id")) == config.STUDENT_ID for o in observees):
            raise SystemExit(
                f"CANVAS_STUDENT_ID={config.STUDENT_ID} is not observed by this account. "
                f"Observed IDs: {', '.join(str(o.get('id')) for o in observees)}"
            )
        return config.STUDENT_ID

    if len(observees) > 1:
        listed = ", ".join(f"{o.get('id')} ({o.get('name')})" for o in observees)
        raise SystemExit(
            f"This account observes {len(observees)} students. "
            f"Set CANVAS_STUDENT_ID in .env to one of: {listed}"
        )

    return str(observees[0]["id"])


def fetch_courses(client, student_id):
    # observed_users surfaces the student's own enrollment -- and so the
    # student's grade -- alongside the observer's scoreless one.
    includes = ["total_scores", "term"]
    if student_id:
        includes.append("observed_users")

    raw = client.get_all(
        "/api/v1/users/self/courses",
        enrollment_state="active",
        **{"include[]": includes},
    )

    courses = []
    unmapped = []
    for course in raw:
        # Courses whose term has ended come back as a stub with no name.
        if course.get("access_restricted_by_date") or not course.get("name"):
            continue
        if not config.course_allowed(course["name"]):
            continue

        # The observer's own enrollment is also type "student"-adjacent noise,
        # so match on the student's user_id when observing.
        score = grade = None
        for enrollment in course.get("enrollments") or []:
            if enrollment.get("type") != "student":
                continue
            if student_id and str(enrollment.get("user_id")) != str(student_id):
                continue
            score = enrollment.get("computed_current_score")
            grade = enrollment.get("computed_current_grade")
            break

        # The raw district name never leaves this function.
        if config.matched_label(course["name"]) is None:
            unmapped.append(course["name"])

        courses.append(
            {
                "id": str(course["id"]),
                "name": config.course_label(course["name"]),
                "score": score,
                "grade": grade,
            }
        )

    if unmapped:
        print("  warning: no label configured for these courses, so a tidied")
        print("           version of the district name will be published:")
        for name in unmapped:
            print(f"             {name!r} -> {config.tidy_course(name)!r}")
        print("           add them to course_labels.json to control this.")

    return courses


def fetch_periods(client, course, student_id, now):
    """Attach the course's grading periods (quarters) and the official grade in each.

    Canvas computes a separate grade per period -- the one on the report card --
    and only hands it out when asked for that period by ID. Periods that have
    not started yet are listed but not queried; they cannot have a grade.
    """
    try:
        raw = client.get_all(f"/api/v1/courses/{course['id']}/grading_periods")
    except Exception as exc:
        print(f"    {course['name']}: no grading periods ({exc})")
        course["periods"] = {}
        return []

    periods = []
    for page in raw:
        periods.extend(page.get("grading_periods") or [])
    periods.sort(key=lambda p: p.get("start_date") or "")

    grades = {}
    for period in periods:
        start = parse_time(period.get("start_date"))
        entry = {"score": None, "grade": None}
        if start and start <= now:
            params = {"type[]": ["StudentEnrollment"], "grading_period_id": period["id"]}
            if student_id:
                params["user_id"] = student_id
            for enrollment in client.get_all(
                f"/api/v1/courses/{course['id']}/enrollments", **params
            ):
                if student_id and str(enrollment.get("user_id")) != str(student_id):
                    continue
                found = enrollment.get("grades") or {}
                entry = {"score": found.get("current_score"), "grade": found.get("current_grade")}
                break
        grades[period_key(period)] = entry

    course["periods"] = grades
    return [
        {
            "id": period_key(period),
            "canvas_id": str(period["id"]),
            "title": period.get("title") or f"Period {period['id']}",
            "start": period.get("start_date"),
            "end": period.get("end_date"),
        }
        for period in periods
    ]


def period_key(period):
    """Quarters are matched across courses by title, not Canvas ID.

    A semester course can sit in its own grading-period set whose "Q1-2627"
    has a different ID from everyone else's, but it is the same report-card
    quarter.
    """
    return period.get("title") or str(period["id"])


def period_for(assignment, submission, periods):
    """Which grading period an assignment counts toward.

    Canvas's own answer wins where the submission carries one -- a teacher can
    move work between quarters. Otherwise it follows the due date, and undated
    work goes to the last period, which is where Canvas counts it too.
    """
    own = str((submission or {}).get("grading_period_id") or "")
    for period in periods:
        if own and period["canvas_id"] == own:
            return period["id"]
    if not periods:
        return None

    due = parse_time(assignment.get("due_at"))
    if due is None:
        return periods[-1]["id"]
    for period in periods:
        start, end = parse_time(period["start"]), parse_time(period["end"])
        if start and end and start <= due <= end:
            return period["id"]
    return None


def classify(assignment, submission, now):
    """Reduce Canvas's submission state to one bucket the board can render."""
    due = parse_time(assignment.get("due_at"))
    submission = submission or {}
    state = submission.get("workflow_state")

    if submission.get("excused"):
        return "excused", due
    if state == "graded" and submission.get("score") is not None:
        return "graded", due
    if submission.get("submitted_at"):
        # Includes pending_review, e.g. a quiz with manually-graded questions.
        return "awaiting_grading", due
    if submission.get("missing"):
        return "missing", due
    if due and due < now:
        return "missing", due
    return "upcoming", due


def fetch_pairs(client, course, student_id):
    """Yield (assignment, submission) pairs for the student.

    Observers cannot use assignments?include[]=submission -- that returns the
    observer's own (nonexistent) submissions -- so the submissions endpoint is
    queried for the named student and the assignment is embedded instead.
    """
    if student_id:
        raw = client.get_all(
            f"/api/v1/courses/{course['id']}/students/submissions",
            **{"student_ids[]": [student_id], "include[]": ["assignment"]},
        )
        return [
            (submission["assignment"], submission)
            for submission in raw
            if submission.get("assignment")
        ]

    raw = client.get_all(
        f"/api/v1/courses/{course['id']}/assignments",
        **{"include[]": ["submission"]},
    )
    return [(item, item.get("submission") or {}) for item in raw]


def fetch_assignments(client, course, student_id, now, periods):
    graded_cutoff = now - timedelta(days=config.GRADED_HISTORY_DAYS)
    missing_cutoff = now - timedelta(days=MISSING_HISTORY_DAYS)

    # Every quarter's breakdown needs its graded work, so history reaches back
    # to the start of the school year. The board trims the Homework view to
    # GRADED_HISTORY_DAYS itself.
    year_start = min(
        (parse_time(p["start"]) for p in periods if parse_time(p["start"])),
        default=None,
    )
    if year_start:
        graded_cutoff = min(graded_cutoff, year_start)
        missing_cutoff = min(missing_cutoff, year_start)

    assignments = []
    for item, submission in fetch_pairs(client, course, student_id):
        status, due = classify(item, submission, now)

        # Trim old history so the board stays about the current school year.
        if status in ("graded", "awaiting_grading", "excused"):
            stamp = parse_time(submission.get("graded_at")) or parse_time(
                submission.get("submitted_at")
            ) or due
            if stamp and stamp < graded_cutoff:
                continue
        elif status == "missing" and due and due < missing_cutoff:
            continue

        record = {
            "id": f"{course['id']}-{item['id']}",
            "course_id": course["id"],
            "title": item.get("name") or "Untitled assignment",
            "due_at": item.get("due_at"),
            "status": status,
            "period_id": period_for(item, submission, periods),
            "points_possible": item.get("points_possible"),
            "score": submission.get("score"),
            "grade": submission.get("grade"),
            "submitted_at": submission.get("submitted_at"),
            "graded_at": submission.get("graded_at"),
            "late": bool(submission.get("late")),
            # Paper and in-person work can never be "submitted" in Canvas,
            # so the board offers a manual toggle for these instead.
            "offline": bool(
                set(item.get("submission_types") or []) & {"on_paper", "none"}
            ),
        }
        if config.INCLUDE_LINKS and item.get("html_url"):
            record["url"] = item["html_url"]

        assignments.append(record)

    return assignments


def build():
    now = datetime.now(timezone.utc)

    print(f"Connecting to {config.BASE_URL} ...")
    client = canvas_client.connect()
    print(f"  connected via {client.label}")

    try:
        student_id = resolve_student(client)
        if student_id:
            print(f"  observer account; reading student {student_id}")

        courses = fetch_courses(client, student_id)
        if not courses:
            raise SystemExit(
                "No active courses came back. Check INCLUDE_COURSES/EXCLUDE_COURSES in .env"
            )
        print(f"  {len(courses)} course(s)")

        assignments = []
        all_periods = {}
        for course in courses:
            periods = fetch_periods(client, course, student_id, now)
            for period in periods:
                public = {k: v for k, v in period.items() if k != "canvas_id"}
                all_periods.setdefault(period["id"], public)
            found = fetch_assignments(client, course, student_id, now, periods)
            assignments.extend(found)
            print(f"    {course['name']}: {len(found)} assignment(s), {len(periods)} grading period(s)")
    finally:
        client.close()

    assignments.sort(key=lambda a: (a["due_at"] is None, a["due_at"] or ""))

    data = {
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        # Quarters across all courses, in calendar order. Each course's
        # "periods" says which of these it runs in and the grade for each.
        "periods": sorted(all_periods.values(), key=lambda p: p["start"] or ""),
        "graded_history_days": config.GRADED_HISTORY_DAYS,
        "courses": courses,
        "assignments": assignments,
    }

    # Not a secret: the worker also demands a bearer key the board never publishes.
    if config.SYNC_URL:
        data["sync_url"] = config.SYNC_URL

    # Surface the token deadline on the board itself -- that is the page
    # actually looked at every day, so it is where the reminder will land.
    days_left = config.token_days_left()
    if days_left is not None:
        data["token_expires"] = config.TOKEN_EXPIRES
        data["token_days_left"] = days_left
        if days_left < 0:
            print(f"  WARNING: the Canvas token expired {-days_left} day(s) ago")
        elif days_left <= 30:
            print(f"  NOTE: the Canvas token expires in {days_left} day(s)")

    return data


def main():
    config.validate()
    data = build()

    config.DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.DATA_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    counts = {}
    for assignment in data["assignments"]:
        counts[assignment["status"]] = counts.get(assignment["status"], 0) + 1
    summary = ", ".join(f"{value} {key}" for key, value in sorted(counts.items()))
    print(f"Wrote {config.DATA_PATH} -- {len(data['assignments'])} assignments ({summary})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
