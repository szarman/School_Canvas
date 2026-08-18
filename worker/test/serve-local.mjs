/* Runs the real worker on localhost with in-memory KV, for end-to-end testing
   of the board without deploying or touching a Cloudflare account. */
import { createServer } from "node:http";
import worker from "../src/index.js";

const PORT = 8787;
const store = new Map();

const FLAGS = {
  async put(name, value, opts = {}) { store.set(name, { value, metadata: opts.metadata || null }); },
  async get(name, type) {
    const hit = store.get(name);
    return hit ? (type === "json" ? JSON.parse(hit.value) : hit.value) : null;
  },
  async getWithMetadata(name) {
    const hit = store.get(name);
    return hit ? { value: hit.value, metadata: hit.metadata } : { value: null, metadata: null };
  },
  async list({ prefix = "" } = {}) {
    return {
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
        .map((name) => ({ name, metadata: store.get(name).metadata })),
      list_complete: true, cursor: null,
    };
  },
};

const env = {
  FLAGS,
  SYNC_KEY: process.env.SYNC_KEY || "test-key",
  ALLOWED_ORIGIN: "http://localhost:8765,https://szarman.github.io",
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`worker stub on http://localhost:${PORT}`));
