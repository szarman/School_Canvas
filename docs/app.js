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

const VIEW_KEY = "hwboard.view.v1";
const SYNC_KEY_STORAGE = "hwboard.synckey.v1";

const state = {
  data: { courses: [], assignments: [], generated_at: null },
  flags: loadFlags(),
  courseFilter: null,
  search: "",
  hideDone: false,
  view: localStorage.getItem(VIEW_KEY) === "grades" ? "grades" : "homework",
  sync: {
    url: null,                                          // from data.json
    key: localStorage.getItem(SYNC_KEY_STORAGE) || "",  // per device
    status: "off",                                      // off|syncing|ok|error|unauthorized
    detail: "",
  },
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
  // A cleared mark is stored as {done:false, turnedIn:false} rather than
  // removed. Sync cannot tell a deleted entry from one that was never set, so
  // a device still holding the old value would restore it on its next merge.
  state.flags[id] = { ...flagsFor(id), [name]: value, ts: new Date().toISOString() };
  saveFlags();
  queuePush([id]);
}

/* Drop manual marks Canvas has since confirmed, so they cannot drift apart. */
function reconcileFlags(assignments) {
  const cleared = [];

  for (const assignment of assignments) {
    // Once Canvas has the work -- submitted, graded or excused -- both marks
    // are implied by definition. Stored ones are noise that can only end up
    // contradicting Canvas, so they are cleared here and on every device.
    const flags = state.flags[assignment.id];
    if (flags && canvasConfirmed(assignment) && (flags.done || flags.turnedIn)) {
      state.flags[assignment.id] = { done: false, turnedIn: false, ts: new Date().toISOString() };
      cleared.push(assignment.id);
    }
  }

  if (cleared.length) {
    saveFlags();
    queuePush(cleared);
  }
}

function canvasConfirmed(assignment) {
  return ["awaiting_grading", "graded", "excused"].includes(assignment.status);
}

/* ---------- cross-device sync ------------------------------------------ */

/* The board stays usable with sync off, unreachable, or unauthorised --
 * localStorage remains the working copy and the worker is an overlay on top.
 * Merging is last-write-wins per assignment, compared on the ISO timestamp
 * each mark carries. */

const syncPending = new Set();
let syncTimer = null;
let syncInFlight = false;

const syncConfigured = () => Boolean(state.sync.url && state.sync.key);
const isNewer = (a, b) => String((a && a.ts) || "") > String((b && b.ts) || "");

function setSyncStatus(status, detail = "") {
  state.sync.status = status;
  state.sync.detail = detail;
  renderSyncStatus();
}

async function syncRequest(method, body) {
  const response = await fetch(state.sync.url, {
    method,
    headers: {
      Authorization: `Bearer ${state.sync.key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  if (response.status === 401 || response.status === 403) {
    const error = new Error("the sync key was rejected");
    error.unauthorized = true;
    throw error;
  }
  if (!response.ok) throw new Error(`sync server returned HTTP ${response.status}`);
  return response.json();
}

/** Adopt any remote entry newer than the local one. Returns true if changed. */
function adoptRemote(remote) {
  let changed = false;
  for (const [id, entry] of Object.entries(remote || {})) {
    if (!state.flags[id] || isNewer(entry, state.flags[id])) {
      state.flags[id] = entry;
      changed = true;
    }
  }
  return changed;
}

/** Full two-way reconcile: pull everything, push whatever is newer here. */
async function syncNow() {
  if (!syncConfigured() || syncInFlight) return;
  syncInFlight = true;
  setSyncStatus("syncing");
  try {
    const { flags: remote } = await syncRequest("GET");

    const outgoing = {};
    for (const [id, entry] of Object.entries(state.flags)) {
      if (!remote[id] || isNewer(entry, remote[id])) outgoing[id] = entry;
    }
    adoptRemote(remote);

    if (Object.keys(outgoing).length) {
      const { flags: merged } = await syncRequest("POST", { changes: outgoing });
      adoptRemote(merged);
    }

    saveFlags();
    setSyncStatus("ok");
    render();
  } catch (error) {
    setSyncStatus(error.unauthorized ? "unauthorized" : "error", error.message);
  } finally {
    syncInFlight = false;
  }
}

/** Coalesce rapid ticking into one request. */
function queuePush(ids) {
  if (!syncConfigured()) return;
  ids.forEach((id) => syncPending.add(id));
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushPush, 700);
}

async function flushPush() {
  if (!syncConfigured() || !syncPending.size) return;
  if (syncInFlight) {
    syncTimer = setTimeout(flushPush, 400);
    return;
  }

  const changes = {};
  for (const id of syncPending) {
    if (state.flags[id]) changes[id] = state.flags[id];
  }
  syncPending.clear();

  syncInFlight = true;
  setSyncStatus("syncing");
  try {
    const { flags: merged } = await syncRequest("POST", { changes });
    if (adoptRemote(merged)) {
      saveFlags();
      render();
    }
    setSyncStatus("ok");
  } catch (error) {
    // Put them back so the next attempt retries rather than losing the tick.
    Object.keys(changes).forEach((id) => syncPending.add(id));
    setSyncStatus(error.unauthorized ? "unauthorized" : "error", error.message);
  } finally {
    syncInFlight = false;
  }
}

function renderSyncStatus() {
  const node = document.getElementById("sync-status");
  if (!node) return;

  const messages = {
    off: state.sync.url
      ? "Not connected on this device. Marks stay in this browser only."
      : "Sync is not set up. Marks stay in this browser only.",
    syncing: "Syncing…",
    ok: "Connected. Marks sync across your devices.",
    unauthorized: "That sync key was rejected. Reconnect with the right one.",
    error: `Could not reach the sync server (${state.sync.detail}). Marks are saved on this device and will retry.`,
  };

  node.textContent = messages[state.sync.status] || messages.off;
  node.className = `syncstatus ${state.sync.status}`;

  const connect = document.getElementById("sync-connect");
  if (connect) {
    connect.textContent = state.sync.key ? "Change sync key" : "Connect this device";
    connect.disabled = !state.sync.url;
  }
  for (const id of ["sync-now", "sync-disconnect"]) {
    const button = document.getElementById(id);
    if (button) button.disabled = !syncConfigured();
  }
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

  // A graded or submitted assignment is finished and handed in by definition,
  // so both boxes read checked and locked rather than inviting a mark that
  // could only contradict Canvas.
  const lockNote = confirmed ? "Confirmed by Canvas" : "";

  const doneBox = el("input", {
    type: "checkbox",
    checked: confirmed || flags.done,
    disabled: confirmed,
    title: lockNote,
  });
  doneBox.addEventListener("change", () => {
    setFlag(assignment.id, "done", doneBox.checked);
    render();
  });

  const turnedInBox = el("input", {
    type: "checkbox",
    checked: confirmed || flags.turnedIn,
    disabled: confirmed,
    title: lockNote,
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

/* ---------- grades view ------------------------------------------------- */

function markColor(pct) {
  if (pct === null) return "var(--muted)";
  if (pct >= 90) return "var(--ok)";
  if (pct >= 80) return "var(--accent)";
  if (pct >= 70) return "var(--warn)";
  return "var(--danger)";
}

/* Points tallied from what is on the board. Canvas's own course percentage is
 * authoritative -- it applies category weights this cannot see -- so it is
 * preferred for the headline whenever Canvas supplies one. */
function courseStats(courseId) {
  const items = state.data.assignments.filter((a) => a.course_id === courseId);
  const scored = items.filter((a) => a.status === "graded" && a.score !== null);

  const earned = scored.reduce((sum, a) => sum + a.score, 0);
  const possible = scored.reduce((sum, a) => sum + (a.points_possible || 0), 0);

  const pending = items.filter((a) => !["graded", "excused"].includes(a.status));
  const outstanding = pending.reduce((sum, a) => sum + (a.points_possible || 0), 0);
  const atRisk = items.filter((a) => a.status === "missing");

  return {
    items, scored, pending, atRisk,
    earned, possible, outstanding,
    pct: possible > 0 ? (earned / possible) * 100 : null,
    riskPoints: atRisk.reduce((sum, a) => sum + (a.points_possible || 0), 0),
  };
}

function tableHead() {
  return el("thead", {}, [
    el("tr", {}, [
      el("th", { text: "Assignment" }),
      el("th", { text: "Score" }),
      el("th", { text: "%" }),
    ]),
  ]);
}

const round2 = (n) => Math.round(n * 100) / 100;

/* Graded work, always visible -- this is the part worth seeing at a glance,
 * with a total row so the class adds up on screen. */
function gradedTable(stats) {
  if (!stats.scored.length) return null;

  const rows = [...stats.scored]
    .sort((a, b) => String(b.graded_at || b.due_at || "").localeCompare(String(a.graded_at || a.due_at || "")))
    .map((a) => {
      const pct = a.points_possible ? Math.round((a.score / a.points_possible) * 100) : null;
      return el("tr", {}, [
        el("td", { text: a.title }),
        el("td", { text: a.points_possible ? `${round2(a.score)} / ${a.points_possible}` : String(round2(a.score)) }),
        el("td", { class: `pct${pct !== null && pct < 70 ? " low" : ""}`, text: pct === null ? "—" : `${pct}%` }),
      ]);
    });

  const totalPct = stats.possible ? Math.round((stats.earned / stats.possible) * 100) : null;

  return el("table", { class: "scorelist" }, [
    tableHead(),
    el("tbody", {}, rows),
    el("tfoot", {}, [
      el("tr", {}, [
        el("td", { text: `Total — ${stats.scored.length} graded` }),
        el("td", { text: `${round2(stats.earned)} / ${round2(stats.possible)}` }),
        el("td", {
          class: `pct${totalPct !== null && totalPct < 70 ? " low" : ""}`,
          text: totalPct === null ? "—" : `${totalPct}%`,
        }),
      ]),
    ]),
  ]);
}

/* Ungraded work is folded away -- it has no scores to read, and it is already
 * the whole point of the Homework view. */
function pendingDetails(stats) {
  if (!stats.pending.length) return null;

  const rows = stats.pending.map((a) =>
    el("tr", {}, [
      el("td", { class: "pending", text: a.title }),
      el("td", { class: "pending", text: a.points_possible ? `— / ${a.points_possible}` : "—" }),
      el("td", { class: "pending", text: a.status === "missing" ? "missing" : "not graded" }),
    ])
  );

  const worth = stats.outstanding ? ` worth ${stats.outstanding} points` : "";
  return el("details", {}, [
    el("summary", {
      text: `${stats.pending.length} assignment${stats.pending.length === 1 ? "" : "s"} not graded yet${worth}`,
    }),
    el("table", { class: "scorelist" }, [tableHead(), el("tbody", {}, rows)]),
  ]);
}

function renderGrades() {
  const host = document.getElementById("grades");

  if (!state.data.courses.length) {
    host.replaceChildren(el("p", { class: "empty", text: "No courses yet." }));
    return;
  }

  const cards = state.data.courses.map((course) => {
    const stats = courseStats(course.id);

    // Canvas's number wins when present; otherwise fall back to the tally.
    const official = course.score !== null && course.score !== undefined;
    const headlinePct = official ? course.score : stats.pct;
    const color = markColor(headlinePct);

    const markText = official
      ? course.grade
        ? `${course.grade}  ${Math.round(course.score * 10) / 10}%`
        : `${Math.round(course.score * 10) / 10}%`
      : stats.pct !== null
        ? `${Math.round(stats.pct)}%`
        : "No grades yet";

    const stat = [];
    if (stats.scored.length) {
      stat.push(
        el("span", {}, [
          el("b", { text: `${Math.round(stats.earned * 100) / 100} / ${stats.possible}` }),
          document.createTextNode(` points on ${stats.scored.length} graded`),
        ])
      );
    }
    if (stats.outstanding) {
      stat.push(
        el("span", {}, [
          el("b", { text: String(stats.outstanding) }),
          document.createTextNode(` points still out across ${stats.pending.length} assignment${stats.pending.length === 1 ? "" : "s"}`),
        ])
      );
    }
    if (stats.atRisk.length) {
      stat.push(
        el("span", { class: "risk" }, [
          el("b", { text: String(stats.atRisk.length) }),
          document.createTextNode(` overdue${stats.riskPoints ? `, worth ${stats.riskPoints} points` : ""}`),
        ])
      );
    }
    if (!stat.length) {
      stat.push(el("span", { text: "Nothing posted for this class yet." }));
    }

    return el("section", { class: "gradecard", style: `--mark-color: ${color}` }, [
      el("div", { class: "gradecard-head" }, [
        el("span", { class: "name", text: course.name }),
        el("span", { class: `mark${headlinePct === null ? " none" : ""}`, text: markText }),
      ]),
      headlinePct === null
        ? null
        : el("div", { class: "bar" }, [
            el("span", { style: `width: ${Math.max(0, Math.min(100, headlinePct))}%` }),
          ]),
      el("div", { class: "stats" }, stat),
      gradedTable(stats),
      pendingDetails(stats),
    ]);
  });

  host.replaceChildren(...cards);
}

/* ---------- view switching ---------------------------------------------- */

function setView(view) {
  state.view = view;
  localStorage.setItem(VIEW_KEY, view);
  render();
}

function render() {
  const grades = state.view === "grades";

  document.getElementById("board").hidden = grades;
  document.getElementById("grades").hidden = !grades;
  // Search and filters drive the homework list only.
  document.querySelector(".controls").hidden = grades;
  document.getElementById("tiles").hidden = grades;
  document.getElementById("courses").hidden = grades;

  for (const button of document.querySelectorAll(".viewbtn")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }

  renderUpdated();
  if (grades) {
    renderGrades();
    return;
  }

  renderTiles(state.data.assignments);
  renderCourses();
  renderFilters();
  renderBoard(visibleAssignments());
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
  for (const button of document.querySelectorAll(".viewbtn")) {
    button.addEventListener("click", () => setView(button.dataset.view));
  }

  document.getElementById("sync-connect").addEventListener("click", () => {
    const entered = prompt(
      "Enter the sync key for this homework board.\n\n" +
        "It is the same key on every device. Leave blank to cancel."
    );
    if (entered === null || !entered.trim()) return;
    state.sync.key = entered.trim();
    localStorage.setItem(SYNC_KEY_STORAGE, state.sync.key);
    syncNow();
  });

  document.getElementById("sync-now").addEventListener("click", syncNow);

  document.getElementById("sync-disconnect").addEventListener("click", () => {
    if (!confirm("Stop syncing on this device? Marks already here are kept.")) return;
    state.sync.key = "";
    localStorage.removeItem(SYNC_KEY_STORAGE);
    setSyncStatus("off");
  });

  // Pick up marks made on another device when the tab comes back into view.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNow();
  });

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

  state.sync.url = state.data.sync_url || window.HWBOARD_SYNC_URL || null;
  setSyncStatus(syncConfigured() ? "syncing" : "off");

  reconcileFlags(state.data.assignments);
  render();

  // Local marks are already on screen; the pull only ever adds to them.
  if (syncConfigured()) syncNow();
}

main();
