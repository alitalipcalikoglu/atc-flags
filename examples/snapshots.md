# Client-side evaluation with snapshots

An application with many users should not call the service per user. It fetches the environment's rule set once, keeps it in memory, re-validates with `If-None-Match`, and evaluates locally. The rules are simple enough to implement in a page of code.

```bash
fcurl $FLAGS/v1/snapshot/prod -D -
```

```
HTTP/1.1 200 OK
etag: "prod-9"
cache-control: private, max-age=0, must-revalidate

{ "env": "prod", "version": 9, "flags": {
  "checkout.new": { "kind": "boolean", "salt": "4f1c9a0e7b2d3e55", "enabled": true, "value": true, "offValue": false, "percentage": 10,
                    "rules": [ { "id": "staff", "match": { "emails": ["ada@example.com"] }, "value": true } ] },
  "search.limit": { "kind": "number", "salt": "…", "enabled": true, "value": 50, "offValue": 10, "percentage": 100, "rules": [] }
} }
```

```bash
fcurl $FLAGS/v1/snapshot/prod -H 'If-None-Match: "prod-9"' -o /dev/null -w '%{http_code}\n'   # 304 until something changes
```

Archived flags are not in the snapshot. The `salt` is what makes local buckets equal the server's.

## A small client

```js
import { createHash } from 'node:crypto';

export class LocalFlags {
  /** @param {{ url: string, apiKey: string, env: string, pollMs?: number, log?: Console }} o */
  constructor({ url, apiKey, env, pollMs = 15_000, log = console }) {
    Object.assign(this, { url: url.replace(/\/+$/, ''), apiKey, env, log });
    /** @type {Record<string, any>} */ this.flags = {};
    this.etag = '';
    this.timer = setInterval(() => this.refresh().catch((e) => log.warn(`flags refresh failed: ${e.message}`)), pollMs).unref();
  }

  async refresh() {
    const res = await fetch(`${this.url}/v1/snapshot/${this.env}`, { headers: { authorization: `Bearer ${this.apiKey}`, ...(this.etag ? { 'if-none-match': this.etag } : {}) }, signal: AbortSignal.timeout(5_000) });
    if (res.status === 304) return false;
    if (!res.ok) throw new Error(`snapshot responded ${res.status}`);
    this.flags = (await res.json()).flags;
    this.etag = res.headers.get('etag') ?? '';
    return true;
  }

  /** @param {string} key @param {{ userId?: string, email?: string, attrs?: Record<string, string> }} ctx */
  evaluate(key, ctx = {}) {
    const f = this.flags[key];
    if (!f) return undefined;
    if (!f.enabled) return f.offValue;
    for (const r of f.rules) if (LocalFlags.matches(r.match, ctx)) return r.value;
    if (f.percentage >= 100) return f.value;
    const id = ctx.userId ?? ctx.email?.toLowerCase();
    if (!id || f.percentage <= 0) return f.offValue;
    const bucket = createHash('sha256').update(f.salt).update(':').update(id).digest().readUInt32BE(0) % 10_000;
    return bucket < f.percentage * 100 ? f.value : f.offValue;
  }

  /** @param {any} m @param {any} ctx */
  static matches(m, ctx) {
    if (m.userIds?.length && (!ctx.userId || !m.userIds.includes(ctx.userId))) return false;
    if (m.emails?.length && (!ctx.email || !m.emails.includes(ctx.email.toLowerCase()))) return false;
    if (m.attrs) for (const [k, allowed] of Object.entries(m.attrs)) { const v = ctx.attrs?.[k]; if (v === undefined || !allowed.includes(v)) return false; }
    return Boolean(m.userIds?.length || m.emails?.length || (m.attrs && Object.keys(m.attrs).length));
  }

  close() { clearInterval(this.timer); }
}
```

```js
const flags = new LocalFlags({ url: process.env.FLAGS_URL, apiKey: process.env.FLAGS_API_KEY, env: 'prod' });
await flags.refresh();                       // once at startup; afterwards every 15 s with ETag
atc-flags.evaluate('checkout.new', { userId: user.id }) ?? false;
```

This is the same algorithm the service runs; the service's own tests pin it. If the service is down the client keeps the last snapshot, which is the intended failure mode.

## Compatibility contract for the bucketing formula

[`golden-vectors.json`](golden-vectors.json) freezes 500 `(salt, id, percentage)` inputs against the real `Evaluator.bucket()` output and rollout/excluded decision, including boundary cases (0%, 100%, a bucket exactly one above/below a threshold, unicode and empty ids, a 500+ character id, and the same id under two different salts). [`evaluator.js`](evaluator.js) is a standalone, runnable copy of the production evaluator (it re-exports the real class so it cannot drift). `test/golden-vectors.test.js` replays every vector against `src/domain/evaluator.js` on every run. Any change to the bucketing formula or its threshold comparison is a breaking change to that contract, not a silent tweak — it needs an explicit, documented compatibility decision (e.g. a reshuffle-style migration), because it would move users across the rollout line in this doc's client and in every application that ports the formula.

## Browser applications

Do not ship an API key to browsers. Either evaluate on your backend and embed the results in the page, or put a tiny endpoint in front (`GET /my-flags` → your backend calls `/v1/evaluate` with the session's user).
