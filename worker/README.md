# Homework Board sync worker

Keeps the **Done** and **Turned in** marks in step across every device. Canvas
stays the source of truth for submitted and graded work; this only holds the
marks a person makes by hand.

Free tier is far more than enough: Cloudflare allows 100,000 KV reads and 1,000
writes a day, and one household generates a handful of writes.

## Setup

Run everything below from **this `worker/` folder**.

### 1. Sign in

```bash
npx wrangler login
```

Opens a browser to authorise. One time only.

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create FLAGS
```

It prints an `id`. Paste it into `wrangler.toml`, replacing
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`.

### 3. Set the shared key

Invent a passphrase — long and random, but something you can retype on a phone.
This is what every device enters once, and the only thing standing between the
public internet and your marks.

```bash
npx wrangler secret put SYNC_KEY
```

It prompts, and the value is never written to disk or into git. Keep a copy in
your password manager.

### 4. Deploy

```bash
npx wrangler deploy
```

It prints a URL like `https://homework-board-sync.<your-subdomain>.workers.dev`.

### 5. Point the board at it

In the project's `.env`:

```
SYNC_URL=https://homework-board-sync.<your-subdomain>.workers.dev
```

Then from the project root:

```bash
python run_daily.py
```

### 6. Connect each device

Open the board, **Settings → Connect this device**, enter the key. Once per
device; it is remembered afterwards.

## How it works

`GET /` returns every mark. `POST /` takes `{changes: {id: {done, turnedIn,
ts}}}` and merges. Both require `Authorization: Bearer <SYNC_KEY>`.

Each assignment is its own KV key. A single shared blob would need
read-modify-write, so two devices ticking different boxes at the same moment
would silently lose one. Independent keys cannot collide. Reads use `list()`,
which returns each key's metadata inline, so the whole set arrives in one call.

Conflicts resolve by the ISO timestamp on each mark — newest wins, per
assignment. Clearing a mark stores `{done:false, turnedIn:false}` rather than
deleting the key, because a deletion is indistinguishable from "never set" and
a device holding the old value would restore it on its next sync.

The board keeps working when sync is off, unreachable, or the key is wrong:
localStorage stays the working copy and the worker is an overlay. Failed pushes
are retried rather than dropped.

Marks sync on load, when the tab regains focus, and about a second after each
tick.

## Testing without deploying

```bash
node test/worker.test.mjs      # 21 assertions against an in-memory KV
node test/serve-local.mjs      # runs the real worker on localhost:8787
```

For the local server, set `sync_url` to `http://localhost:8787` in
`docs/data.json` and use the key `test-key`.

## Changing the key

```bash
npx wrangler secret put SYNC_KEY
```

Then reconnect each device. Old marks are unaffected — the key guards access,
it does not encrypt anything.

## Limits worth knowing

- KV is eventually consistent. A mark can take a few seconds to appear on
  another device; a refresh always shows the current state.
- Anyone with the key can read and write the marks. It is a shared family
  passphrase, not per-user auth.
- The marks are stored in plain text in KV. They contain assignment IDs and
  true/false — no names, no grades.
