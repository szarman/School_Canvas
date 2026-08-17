/* Homework Board.
 *
 * data.json is regenerated nightly from Canvas and is read-only here.
 * The "Done" and "Turned in" checkmarks are the user's own and live in
 * localStorage. Where the two disagree, Canvas wins: once Canvas reports a
 * real submission, the manual "turned in" mark is retired.
 */

const FLAG_KEY = "hwboard.flags.v1";
const DAY = 86400000;

const GROUPS = [
  { key: "missing",   title: "Overdue & missing", color: "var(--danger)" },
  { key: "due_soon",  title: "Due this week",     color: "var(--warn)" },
  { key: "upcoming",  title: "Coming up",         color: "var(--accent)" },
  { key: "awaiting",  title: "Awaiting grading",  color: "var(--pending)" },
  { key: "graded",    title: "Graded",            color: "var(--ok)" },
];

const state = {
  data: { courses: [], assignments: [], generated_at: null },
  flags: loadFlags(),
  courseFilter: null,
  search: "",
  hideDone: false,
};

/* ---------- storage ---------------------------------------------------- */

function loadFlags() {
  try {
    return JSON.parse(localStorage.getItem(FLAG_KEY)) || {};
  } catch {
    return {};
  }
}

function saveFlags() {
  try {
    localStorage.setItem(FLAG_KEY, JSON.stringify(state.flags));
  } catch {
    /* private browsing or a full quota; the board still works for this visit */
  }
}

function flagsFor(id) {
  return state.flags[id] || { done: false, turnedIn: false };
}

function setFlag(id, name, value) {
  const current = { ...flagsFor(id), [name]: value, ts: new Date().toISOString() };
  if (!current.done && !current.turnedIn) delete state.flags[id];
  else state.flags[id] = current;
  saveFlags();
}

/* Drop manual marks Canvas has since confirmed, so they cannot drift apart. */
function reconcileFlags(assignments) {
  let changed = false;
  const live = new Set(assignments.map((a) => a.id));

  for (const assignment of assignments) {
    const flags = state.flags[assignment.id];
    if (flags && flags.turnedIn && canvasConfirmed(assignment)) {
      delete flags.turnedIn;
      if (!flags.done) delete state.flags[assignment.id];
      changed = true;
    }
  }
  // Forget marks for assignments that have aged off the board.
  for (const id of Object.keys(state.flags)) {
    if (!live.has(id)) {
      delete state.flags[id];
      changed = true;
    }
  }
  if (changed) saveFlags();
}

function canvasConfirmed(assignment) {
  return ["awaiting_grading", "graded", "excused"].includes(assignment.status);
}

/* ---------- dates ------------------------------------------------------ */

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function daysUntil(iso) {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  return Math.round((startOfDay(due) - startOfDay(new Date())) / DAY);
}

/* `settled` means Canvas already has the work, so counting days overdue
 * would be misleading -- show a plain due date instead. */
function formatDue(iso, settled = false) {
  if (!iso) return { text: "No due date", tone: "" };

  const due = new Date(iso);
  const days = daysUntil(iso);
  const stamp = due.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (days === null) return { text: "No due date", tone: "" };
  if (settled) return { text: `Due ${stamp}`, tone: "" };
  if (days < -1) return { text: `${Math.abs(days)} days overdue · ${stamp}`, tone: "urgent" };
  if (days === -1) return { text: `Due yesterday · ${stamp}`, tone: "urgent" };
  if (days === 0) {
    const time = due.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return { text: `Due today at ${time}`, tone: "urgent" };
  }
  if (days === 1) return { text: `Due tomorrow · ${stamp}`, tone: "urgent" };
  if (days <= 3) return { text: `Due ${due.toLocaleDateString(undefined, { weekday: "long" })} · ${stamp}`, tone: "soon" };
  if (days <= 6) return { text: `Due ${due.toLocaleDateString(undefined, { weekday: "long" })} · ${stamp}`, tone: "" };
  return { text: `Due ${stamp}`, tone: "" };
}

function shortDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ---------- grouping --------------------------------------------------- */

function groupOf(assignment) {
  switch (assignment.status) {
    case "graded":
    case "excused":
      return "graded";
    case "awaiting_grading":
      return "awaiting";
    case "missing":
      return "missing";
    default: {
      const days = daysUntil(assignment.due_at);
      return days !== null && days <= 6 ? "due_soon" : "upcoming";
    }
  }
}

function isFinished(assignment) {
  return flagsFor(assignment.id).done || ["graded", "excused"].includes(assignment.status);
}

function visibleAssignments() {
  const needle = state.search.trim().toLowerCase();
  return state.data.assignments.filter((assignment) => {
    if (state.courseFilter && assignment.course_id !== state.courseFilter) return false;
    if (state.hideDone && isFinished(assignment)) return false;
    if (needle && !assignment.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/* ---------- rendering -------------------------------------------------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(child);
  }
  return node;
}

function courseName(id) {
  const course = state.data.courses.find((c) => c.id === id);
  return course ? course.name : "Unknown course";
}

function renderUpdated() {
  const node = document.getElementById("updated");
  if (!state.data.generated_at) {
    node.textContent = "No data yet — run the scraper.";
    return;
  }
  const when = new Date(state.data.generated_at);
  const hoursOld = (Date.now() - when.getTime()) / 3600000;
  node.textContent =
    "Last pulled " +
    when.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  node.classList.toggle("stale", hoursOld > 36);
  if (hoursOld > 36) node.textContent += " — this is out of date";
}

function renderTiles(assignments) {
  const counts = { missing: 0, due_soon: 0, awaiting: 0, graded: 0 };
  for (const assignment of assignments) {
    const group = groupOf(assignment);
    if (group in counts) counts[group] += 1;
  }

  const tiles = [
    { label: "Overdue", value: counts.missing, color: "var(--danger)" },
    { label: "Due this week", value: counts.due_soon, color: "var(--warn)" },
    { label: "Awaiting grading", value: counts.awaiting, color: "var(--pending)" },
    { label: "Graded", value: counts.graded, color: "var(--ok)" },
  ];

  const host = document.getElementById("tiles");
  host.replaceChildren(
    ...tiles.map((tile) =>
      el("div", { class: "tile", style: `--tile-color: ${tile.color}` }, [
        el("div", { class: "value", text: String(tile.value) }),
        el("div", { class: "label", text: tile.label }),
      ])
    )
  );
}

function renderCourses() {
  const host = document.getElementById("courses");
  const withGrades = state.data.courses.filter((c) => c.score !== null && c.score !== undefined);
  host.replaceChildren(
    ...withGrades.map((course) =>
      el("div", { class: "course-grade" }, [
        el("span", { text: course.name }),
        el("span", {
          class: "grade",
          text: course.grade ? `${course.grade} · ${course.score}%` : `${course.score}%`,
        }),
      ])
    )
  );
}

function renderFilters() {
  const host = document.getElementById("course-filter");
  const chips = [{ id: null, name: "All courses" }, ...state.data.courses];

  host.replaceChildren(
    ...chips.map((course) =>
      el("button", {
        class: "chip",
        type: "button",
        "aria-pressed": String(state.courseFilter === course.id),
        text: course.name,
        onclick: () => {
          state.courseFilter = course.id;
          render();
        },
      })
    )
  );
}

function renderCard(assignment, color) {
  const flags = flagsFor(assignment.id);
  const confirmed = canvasConfirmed(assignment);
  const due = formatDue(assignment.due_at, confirmed);

  const titleContent = assignment.url
    ? el("a", { href: assignment.url, target: "_blank", rel: "noopener noreferrer", text: assignment.title })
    : document.createTextNode(assignment.title);

  const meta = [
    el("span", { class: "course", text: courseName(assignment.course_id) }),
    el("span", { class: `due ${due.tone}`, text: due.text }),
  ];

  if (assignment.status === "graded" && assignment.score !== null) {
    const total = assignment.points_possible;
    const pct = total ? Math.round((assignment.score / total) * 100) : null;
    meta.push(
      el("span", {
        class: `badge score${pct !== null && pct < 70 ? " low" : ""}`,
        text: total ? `${assignment.score}/${total}${pct !== null ? ` · ${pct}%` : ""}` : `${assignment.score}`,
      })
    );
  }
  if (assignment.status === "excused") {
    meta.push(el("span", { class: "badge canvas", text: "Excused" }));
  }
  if (assignment.status === "awaiting_grading") {
    meta.push(
      el("span", {
        class: "badge canvas",
        text: assignment.submitted_at ? `Submitted ${shortDate(assignment.submitted_at)}` : "Submitted",
      })
    );
  }
  if (assignment.late) {
    meta.push(el("span", { class: "badge late", text: "Late" }));
  }
  if (assignment.offline && !confirmed) {
    meta.push(el("span", { class: "badge offline", text: "Paper / in class" }));
  }

  const doneBox = el("input", { type: "checkbox", checked: flags.done });
  doneBox.addEventListener("change", () => {
    setFlag(assignment.id, "done", doneBox.checked);
    render();
  });

  const turnedInBox = el("input", {
    type: "checkbox",
    checked: confirmed || flags.turnedIn,
    disabled: confirmed,
    title: confirmed ? "Confirmed by Canvas" : "",
  });
  turnedInBox.addEventListener("change", () => {
    setFlag(assignment.id, "turnedIn", turnedInBox.checked);
    render();
  });

  return el(
    "article",
    {
      class: `card${isFinished(assignment) ? " finished" : ""}`,
      style: `--group-color: ${color}`,
    },
    [
      el("div", { class: "marks" }, [
        el("label", { class: "mark", title: "You finished the work" }, [
          doneBox, el("span", { text: "Done" }),
        ]),
        el("label", { class: "mark" }, [
          turnedInBox, el("span", { text: "Turned in" }),
        ]),
      ]),
      el("div", { class: "card-body" }, [
        el("div", { class: "title" }, [titleContent]),
        el("div", { class: "meta" }, meta),
      ]),
    ]
  );
}

function renderBoard(assignments) {
  const board = document.getElementById("board");

  if (!assignments.length) {
    board.replaceChildren(
      el("p", { class: "empty", text: "Nothing to show. Try clearing the filters." })
    );
    return;
  }

  const buckets = new Map(GROUPS.map((group) => [group.key, []]));
  for (const assignment of assignments) {
    buckets.get(groupOf(assignment)).push(assignment);
  }

  const sections = [];
  for (const group of GROUPS) {
    const items = buckets.get(group.key);
    if (!items.length) continue;

    // Graded work reads best newest-first; everything else by due date.
    if (group.key === "graded") {
      items.sort((a, b) => String(b.graded_at || b.due_at || "").localeCompare(String(a.graded_at || a.due_at || "")));
    }

    sections.push(
      el("section", { class: "group", style: `--group-color: ${group.color}` }, [
        el("h2", {}, [
          document.createTextNode(group.title),
          el("span", { class: "count", text: String(items.length) }),
        ]),
        ...items.map((assignment) => renderCard(assignment, group.color)),
      ])
    );
  }

  board.replaceChildren(...sections);
}

function render() {
  const assignments = visibleAssignments();
  renderUpdated();
  renderTiles(state.data.assignments);
  renderCourses();
  renderFilters();
  renderBoard(assignments);
}

/* ---------- token expiry ----------------------------------------------- */

/* The countdown is computed here rather than read from data.json, because the
 * failure this warns about -- an expired token -- also stops data.json from
 * updating. A baked-in number would freeze at "expires in 1 day" forever. */
function renderTokenBanner() {
  const node = document.getElementById("token-banner");
  const expires = state.data.token_expires;
  if (!expires) {
    node.hidden = true;
    return;
  }

  const days = Math.round((startOfDay(new Date(`${expires}T00:00:00`)) - startOfDay(new Date())) / DAY);
  if (Number.isNaN(days) || days > 30) {
    node.hidden = true;
    return;
  }

  const pretty = new Date(`${expires}T00:00:00`).toLocaleDateString(undefined, {
    month: "long", day: "numeric", year: "numeric",
  });

  node.hidden = false;
  node.classList.toggle("critical", days <= 7);
  if (days < 0) {
    node.textContent =
      `The Canvas access token expired on ${pretty}. The board has stopped updating — ` +
      `create a new token in Canvas (Account → Settings) and put it in .env.`;
  } else if (days === 0) {
    node.textContent =
      `The Canvas access token expires today (${pretty}). Create a new one in ` +
      `Canvas (Account → Settings) and put it in .env.`;
  } else {
    node.textContent =
      `The Canvas access token expires in ${days} day${days === 1 ? "" : "s"} (${pretty}). ` +
      `Create a new one in Canvas (Account → Settings) and put it in .env before then.`;
  }
}

/* ---------- settings --------------------------------------------------- */

function wireSettings() {
  const toggle = document.getElementById("settings-toggle");
  const panel = document.getElementById("settings");
  toggle.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  });

  document.getElementById("export-flags").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.flags, null, 2)], { type: "application/json" });
    const link = el("a", { href: URL.createObjectURL(blob), download: "homework-checkmarks.json" });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  });

  const fileInput = document.getElementById("import-file");
  document.getElementById("import-flags").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      state.flags = { ...state.flags, ...incoming };
      saveFlags();
      reconcileFlags(state.data.assignments);
      render();
    } catch {
      alert("That file could not be read as checkmark data.");
    }
    fileInput.value = "";
  });

  document.getElementById("reset-flags").addEventListener("click", () => {
    if (!confirm("Clear every 'done' and 'turned in' mark on this device?")) return;
    state.flags = {};
    saveFlags();
    render();
  });

  document.getElementById("search").addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });

  document.getElementById("hide-done").addEventListener("change", (event) => {
    state.hideDone = event.target.checked;
    render();
  });
}

/* ---------- boot ------------------------------------------------------- */

async function main() {
  wireSettings();
  try {
    // Cache-bust so a fresh nightly push shows up without a hard reload.
    const response = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
  } catch (error) {
    document.getElementById("board").replaceChildren(
      el("p", { class: "empty", text: `Could not load data.json (${error.message}). Run scrape.py to create it.` })
    );
    document.getElementById("updated").textContent = "No data";
    return;
  }
  document.getElementById("sample-banner").hidden = !state.data.sample;
  renderTokenBanner();
  reconcileFlags(state.data.assignments);
  render();
}

main();
