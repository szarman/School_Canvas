/**
 * Homework Board sync.
 *
 * Stores the "Done" and "Turned in" marks so every device sees the same
 * state. Canvas remains the source of truth for submitted and graded work --
 * this only holds the marks a person makes by hand.
 *
 * Each assignment gets its own KV key. That matters: a single shared blob
 * would need read-modify-write, and two devices ticking different boxes at
 * the same moment would silently lose one of them. Independent keys cannot
 * collide. Reads use list(), which returns each key's metadata inline, so the
 * whole set comes back in one call rather than one call per assignment.
 *
 * Clearing a mark stores {done:false, turnedIn:false} rather than deleting
 * the key. A deletion is indistinguishable from "never set", so a device
 * holding the old value would helpfully restore it on the next sync.
 */

const PREFIX = "flag:";
const MAX_CHANGES = 200;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGIN || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (allowed.length && origin && !allowed.includes(origin)) {
      return json({ error: "origin not allowed" }, 403, cors);
    }
    if (!env.SYNC_KEY) {
      return json({ error: "worker has no SYNC_KEY secret set" }, 500, cors);
    }

    const header = request.headers.get("Authorization") || "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!safeEqual(presented, env.SYNC_KEY)) {
      return json({ error: "unauthorized" }, 401, cors);
    }

    try {
      if (request.method === "GET") {
        return json({ flags: await readAll(env) }, 200, cors);
      }
      if (request.method === "POST") {
        return json({ flags: await applyChanges(env, request) }, 200, cors);
      }
    } catch (error) {
      return json({ error: String((error && error.message) || error) }, 400, cors);
    }
    return json({ error: "method not allowed" }, 405, cors);
  },
};

async function readAll(env) {
  const flags = {};
  let cursor;
  do {
    const page = await env.FLAGS.list({ prefix: PREFIX, cursor });
    for (const key of page.keys) {
      const entry = key.metadata || (await env.FLAGS.get(key.name, "json"));
      if (entry) flags[key.name.slice(PREFIX.length)] = entry;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return flags;
}

async function applyChanges(env, request) {
  const body = await request.json();
  const changes = body && body.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("body must be {changes: {id: {done, turnedIn, ts}}}");
  }

  const ids = Object.keys(changes);
  if (ids.length > MAX_CHANGES) {
    throw new Error(`too many changes in one request (max ${MAX_CHANGES})`);
  }

  await Promise.all(
    ids.map(async (id) => {
      if (!ID_PATTERN.test(id)) return;
      const incoming = normalise(changes[id]);
      if (!incoming) return;

      const name = PREFIX + id;
      const existing = await env.FLAGS.getWithMetadata(name);
      const currentTs = (existing && existing.metadata && existing.metadata.ts) || "";
      // Last write wins, per assignment.
      if (currentTs && currentTs > incoming.ts) return;

      await env.FLAGS.put(name, JSON.stringify(incoming), { metadata: incoming });
    })
  );

  return readAll(env);
}

function normalise(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    done: Boolean(raw.done),
    turnedIn: Boolean(raw.turnedIn),
    ts: typeof raw.ts === "string" && raw.ts ? raw.ts : new Date().toISOString(),
  };
}

/** Length-independent comparison, so a wrong key leaks nothing by timing. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
