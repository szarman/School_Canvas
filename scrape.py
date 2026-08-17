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


def fetch_courses(client):
    raw = client.get_all(
        "/api/v1/users/self/courses",
        enrollment_state="active",
        **{"include[]": ["total_scores", "term"]},
    )

    courses = []
    unmapped = []
    for course in raw:
        # Courses whose term has ended come back as a stub with no name.
        if course.get("access_restricted_by_date") or not course.get("name"):
            continue
        if not config.course_allowed(course["name"]):
            continue

        score = grade = None
        for enrollment in course.get("enrollments") or []:
            if enrollment.get("type") == "student":
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


def fetch_assignments(client, course, now):
    raw = client.get_all(
        f"/api/v1/courses/{course['id']}/assignments",
        **{"include[]": ["submission"]},
    )

    graded_cutoff = now - timedelta(days=config.GRADED_HISTORY_DAYS)
    missing_cutoff = now - timedelta(days=MISSING_HISTORY_DAYS)

    assignments = []
    for item in raw:
        submission = item.get("submission") or {}
        status, due = classify(item, submission, now)

        # Trim old history so the board stays about the current term.
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
        courses = fetch_courses(client)
        if not courses:
            raise SystemExit(
                "No active courses came back. Check INCLUDE_COURSES/EXCLUDE_COURSES in .env"
            )
        print(f"  {len(courses)} course(s)")

        assignments = []
        for course in courses:
            found = fetch_assignments(client, course, now)
            assignments.extend(found)
            print(f"    {course['name']}: {len(found)} assignment(s)")
    finally:
        client.close()

    assignments.sort(key=lambda a: (a["due_at"] is None, a["due_at"] or ""))

    data = {
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "courses": courses,
        "assignments": assignments,
    }

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
