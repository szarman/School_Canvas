/* Exercises the real worker against an in-memory KV stub. */
import worker from "../src/index.js";

const KEY = "s3cret-key";
const ORIGIN = "https://szarman.github.io";

function makeKV() {
  const store = new Map();
  return {
    store,
    async put(name, value, opts = {}) { store.set(name, { value, metadata: opts.metadata || null }); },
    async get(name, type) {
      const hit = store.get(name);
      if (!hit) return null;
      return type === "json" ? JSON.parse(hit.value) : hit.value;
    },
    async getWithMetadata(name) {
      const hit = store.get(name);
      return hit ? { value: hit.value, metadata: hit.metadata } : { value: null, metadata: null };
    },
    async list({ prefix = "", cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
        .map((name) => ({ name, metadata: store.get(name).metadata }));
      return { keys, list_complete: true, cursor: null };
    },
  };
}

const env = () => ({ FLAGS: makeKV(), SYNC_KEY: KEY, ALLOWED_ORIGIN: ORIGIN });

const call = (e, method, { key = KEY, origin = ORIGIN, body } = {}) =>
  worker.fetch(new Request("https://sync.example/", {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }), e);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const e = env();

// --- auth --------------------------------------------------------------
check("no key -> 401", (await call(e, "GET", { key: "" })).status === 401);
check("wrong key -> 401", (await call(e, "GET", { key: "nope" })).status === 401);
check("wrong-length key -> 401", (await call(e, "GET", { key: KEY + "x" })).status === 401);
check("right key -> 200", (await call(e, "GET")).status === 200);

// --- CORS --------------------------------------------------------------
const pre = await call(e, "OPTIONS", { key: "" });
check("preflight -> 204 without auth", pre.status === 204);
check("preflight echoes origin", pre.headers.get("Access-Control-Allow-Origin") === ORIGIN);
check("foreign origin -> 403", (await call(e, "GET", { origin: "https://evil.test" })).status === 403);

// --- empty state -------------------------------------------------------
check("starts empty", Object.keys((await (await call(e, "GET")).json()).flags).length === 0);

// --- write + read ------------------------------------------------------
await call(e, "POST", { body: { changes: {
  "101-1": { done: true, turnedIn: false, ts: "2026-08-18T10:00:00Z" },
  "101-2": { done: false, turnedIn: true, ts: "2026-08-18T10:00:00Z" },
} } });
let flags = (await (await call(e, "GET")).json()).flags;
check("two entries stored", Object.keys(flags).length === 2);
check("done round-trips", flags["101-1"].done === true && flags["101-1"].turnedIn === false);
check("turnedIn round-trips", flags["101-2"].turnedIn === true);

// --- last-write-wins ---------------------------------------------------
await call(e, "POST", { body: { changes: { "101-1": { done: false, turnedIn: false, ts: "2026-08-18T09:00:00Z" } } } });
flags = (await (await call(e, "GET")).json()).flags;
check("older write is ignored", flags["101-1"].done === true);

await call(e, "POST", { body: { changes: { "101-1": { done: false, turnedIn: false, ts: "2026-08-18T11:00:00Z" } } } });
flags = (await (await call(e, "GET")).json()).flags;
check("newer write wins", flags["101-1"].done === false);
check("cleared mark kept as tombstone, not deleted", "101-1" in flags);

// --- validation --------------------------------------------------------
check("bad body -> 400", (await call(e, "POST", { body: { nope: 1 } })).status === 400);
check("array changes -> 400", (await call(e, "POST", { body: { changes: [] } })).status === 400);
await call(e, "POST", { body: { changes: { "../../etc/passwd": { done: true, ts: "2026-08-18T12:00:00Z" } } } });
flags = (await (await call(e, "GET")).json()).flags;
check("dodgy id rejected", !("../../etc/passwd" in flags));
const many = {}; for (let i = 0; i < 201; i++) many["x-" + i] = { done: true, ts: "2026-08-18T12:00:00Z" };
check("oversized batch -> 400", (await call(e, "POST", { body: { changes: many } })).status === 400);

// --- coercion ----------------------------------------------------------
await call(e, "POST", { body: { changes: { "101-3": { done: "yes", turnedIn: 0, ts: "2026-08-18T12:00:00Z" } } } });
flags = (await (await call(e, "GET")).json()).flags;
check("values coerced to booleans", flags["101-3"].done === true && flags["101-3"].turnedIn === false);

// --- misconfig ---------------------------------------------------------
const noSecret = { FLAGS: makeKV(), ALLOWED_ORIGIN: ORIGIN };
check("missing SYNC_KEY -> 500", (await call(noSecret, "GET")).status === 500);

check("method not allowed", (await call(e, "DELETE")).status === 405);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
