# `atc-flags` readiness contract

## Purpose
`atc-flags` lets the rest of the platform gate and tune behaviour without a deploy: it stores feature
flags and typed settings (boolean, string, number, json), one state per environment (`dev`,
`staging`, `prod` by default), and serves evaluation (per-request), snapshots (for client-side
evaluation with polling + `ETag`), percentage rollouts with stable per-user buckets, targeting
rules on user id / email / attributes, and a full change history.

## Dependencies
- `atc-audit` (`AUDIT_URL` + `AUDIT_API_KEY`): optional, both-or-neither. When unset, every write
  request still succeeds — the `AuditClient.hook` `onSend` hook checks `client?.enabled` and is a
  no-op when there is no target. When set, every successful (or 403-denied) write on a route
  carrying `config.audit` is queued in memory (`AuditClient.record`) and flushed in the background
  on a 2s timer (`flushMs`, `src/net/audit-client.js`); the outbound `POST {AUDIT_URL}/v1/events/batch`
  call never sits on the request path, so an unreachable or slow audit service never slows down or
  fails a flags request. If audit stays unreachable, events accumulate in an in-memory ring buffer
  (`MAX_BUFFER = 5_000`, oldest dropped with a warning once full) and are lost on process restart —
  there is no on-disk queue.
- `atc-webhook-out` (`WEBHOOK_OUT_URL` + `WEBHOOK_OUT_API_KEY`, a publish-role key): optional,
  both-or-neither. `flag.changed` events are published best effort from a bounded in-memory queue (500
  events, three retries, an idempotency key each) in the background; the request path never waits
  on it, and events still queued at a restart are lost (atc-stack `docs/EVENTS.md`).

No other service or external system is called by `atc-flags`.

## Persistence
Engine: SQLite via `node:sqlite`'s `DatabaseSync` (`src/db.js`), WAL journal mode, `synchronous =
NORMAL`, `busy_timeout = 5000`, foreign keys on. File location: `DB_PATH`, default
`./data/flags.db` (Docker image sets `/data/flags.db` with `/data` as a declared volume).

Schema (one migration block today, `Database.MIGRATIONS[0]`):
- `atc-flags` — one row per flag key: `key` (PK), `kind`, `description`, `tags` (JSON array), `archived`,
  `rollout_salt`, `created_by`, `created_at`, `updated_at`.
- `flag_envs` — one row per (flag, environment): `key`, `env`, `enabled`, `value`, `off_value`,
  `percentage`, `rules` (JSON), `version`, `updated_by`, `updated_at`; PK `(key, env)`; index
  `flag_envs_env(env)`.
- `env_versions` — one row per environment: `env` (PK), `version`, bumped on every write to that
  environment (the snapshot `ETag` / `X-Flags-Version` source).
- `history` — append-only change log: `id` (autoincrement PK), `key`, `env`, `action`, `actor`,
  `before`, `after` (JSON), `at`; indexes `history_key(key, id DESC)` and `history_at(at)`.

Migration mechanism: `Database.MIGRATIONS` is an ordered array of SQL blocks; on open, `#migrate()`
reads `PRAGMA user_version`, and runs every migration from that point forward, each inside its own
`BEGIN`/`COMMIT` (rolled back on error), bumping `user_version` after each. Fresh install: no file
exists, `DatabaseSync` creates it, `user_version` starts at 0, all migrations run. Upgrade: only
migrations beyond the stored `user_version` run — today there is exactly one, so an "upgrade" from
a nonexistent state and a fresh install do the same thing; there is no rollback/down-migration
mechanism.

## Health endpoint
`GET /health` returns `{ status: 'ok' }` unconditionally — no dependency check, no I/O, cannot be
slow or fail while the process is otherwise alive and the event loop is not blocked. Logged at
`warn` level (so routine polling doesn't spam `info` logs).

## Readiness endpoint
`GET /ready` calls `this.db.ping()` (`SELECT 1`), cached for `FlagsApi.READY_CACHE_MS = 10_000`ms
(`this.readyCache`): a poll within that window returns the cached result without touching the
database. On a stale cache it re-pings synchronously; a throw (e.g. the connection is unusable)
sets the cache to `{ ok: false, error }` and the route replies `503 { status: 'unavailable', error }`.
Safe to poll at any interval: it never mutates state, never discards in-flight work, and its only
side effect is the (idempotent, read-only) `SELECT 1` at most once per 10s.

## Graceful shutdown
`SIGTERM` and `SIGINT` both call `Application.shutdown(reason)` (idempotent via `this.shuttingDown`
guard). Order: stop the maintenance timer (`this.maintenance.stop()`) → `await this.app.close()`
(Fastify stops accepting new connections and drains in-flight requests) → `await this.audit.close()`
(stops the audit flush timer and sends one last flush of whatever is buffered) → `this.db.close()`.
A force-exit timer of `30_000`ms (`setTimeout(..., 30_000).unref()`) runs in parallel; if shutdown
hasn't completed by then it logs and calls `process.exit(1)`. `unhandledRejection` triggers the
same graceful `shutdown('unhandledRejection')` path; `uncaughtException` skips it entirely and
calls `process.exit(1)` immediately (no drain, no final audit flush).

PM2's `kill_timeout` in `ecosystem.config.cjs` is `35000`ms — 5s above the internal 30s force-exit,
so PM2's own SIGKILL only fires as a backstop if the process is stuck *after* its own force-exit
should have already run (the ecosystem file's own comment says as much).

## Resource limits
- `BODY_LIMIT` (env, default `65_536` bytes / 64 KiB) — Fastify request body cap.
- `MAX_VALUE_BYTES` (env, default `16_384` bytes) — JSON-encoded size cap per `value`/`offValue`/rule
  value (`ValueCheck.value`).
- Rules: at most 100 per environment state (`ValueCheck.rules`), each rule's `userIds`/`emails`/
  per-attribute value list capped at `ValueCheck.MAX_LIST = 1_000` entries of ≤254 chars.
- Flag key: ≤80 characters, `list` page size capped implicitly by caller-supplied `limit` (no
  server-side max enforced beyond what's requested — the default is 50).
- `RATE_LIMIT_MAX` (env, default `1_200`) requests per API key per minute (`@fastify/rate-limit`,
  keyed by `request.apiKey.id`).
- `max_memory_restart: '300M'` in `ecosystem.config.cjs` — PM2 restarts the process if it exceeds
  300MB RSS.

## Timeouts
- Audit outbound call: `timeoutMs = 5_000` (`AuditClient` constructor default; `Application` does
  not override it), applied via `AbortSignal.timeout(this.timeoutMs)` per attempt.
- Shutdown force-exit: `30_000`ms, hard-coded in `Application.shutdown` (not environment-configurable).
- PM2 `listen_timeout: 10000`ms — how long PM2 waits for `wait_ready`'s `process.send('ready')`
  before considering startup failed.
- No request-handling timeout is applied to inbound requests themselves (Fastify's own connection
  timeouts aside); flags does not call any other service synchronously in the request path, so
  there is no outward per-request timeout to configure beyond the audit client's own.

## Retry policy
Only the audit forwarding path retries, and only on its own background timer — never in the
request path. `AuditClient.#send` retries up to `MAX_ATTEMPTS = 6` per batch, with backoff
`min(30_000, 500 * 2 ** attempt)`ms between attempts (500ms, 1s, 2s, 4s, 8s, 16s — capped at 30s),
no jitter. A 2xx response marks the batch sent; a 4xx other than 429 is treated as permanently
rejected and the batch is dropped (logged, counted in `stats.dropped`) rather than retried; a 429,
5xx, network error, or timeout is retried within the same `#send` call, and if all 6 attempts are
exhausted the batch stays in the buffer for the *next* scheduled flush (every `flushMs = 2_000`ms)
rather than being retried immediately. Logic lives entirely in `src/net/audit-client.js`.

## Idempotency
- `POST /v1/flags` (create) is **not** idempotent: a repeat with the same `key` fails
  `409 FLAG_EXISTS` rather than silently succeeding.
- `POST /v1/flags`, `POST /v1/flags/:key/envs/:env/copy`, `POST /v1/changes/:id/approve` and
  `POST /v1/changes/:id/reject` accept an optional `Idempotency-Key` header
  (`@atc-web/atc-service-core/idempotency`, v1.30): a repeat with the same key, caller and body
  replays the stored 2xx answer with `Idempotent-Replayed: true` instead of running again, so a
  timed-out create retried with the header neither duplicates nor hits `409 FLAG_EXISTS`.
- `PATCH /v1/flags/:key`, `PATCH /v1/flags/:key/envs/:env` are idempotent in *result* for a fixed
  patch body (applying the same patch twice yields the same end state) but each call still appends
  a new `history` row, so the side effect (history growth) is not idempotent even though the state is.
- `DELETE /v1/flags/:key` is **not** safe to repeat: the second call hits `s.get(key)` inside
  `remove`, which throws `404 FLAG_NOT_FOUND` once the flag is gone, rather than treating a repeat
  delete as a no-op.
- `POST /v1/flags/:key/envs/:env/copy` is idempotent for a fixed `(from, to)` pair while `from` is
  unchanged between calls (copying the same source state twice yields the same destination state,
  modulo a new history row each time).
- `GET /v1/evaluate`, `POST /v1/evaluate`, `GET /v1/snapshot/:env`, `GET /v1/flags*`, `GET
  /v1/history*` are naturally idempotent — read-only.
- Audit events carry a locally generated `id` (`randomUUID()`) per event, but that id's use for
  dedup is entirely up to the audit service's own implementation — `atc-flags` does not verify or rely
  on the audit service deduplicating retried/duplicate batches.

## Backup
State that must survive a disk loss: the SQLite file at `DB_PATH` (default `./data/flags.db`),
including its WAL/SHM sidecar files while the process is running (`*.db-wal`, `*.db-shm`). Nothing
else — configuration is environment variables, not state. To capture it today: stop the process (or
use SQLite's `.backup` / `VACUUM INTO` online backup mechanism against the running WAL-mode
database, which this repo does not currently wire up as a script) and copy the file. There is no
backup script or scheduled job in this repository.

## Restore
Stop the service, replace `DB_PATH` (and remove any stale `-wal`/`-shm` sidecars from the old file
if present) with the backup copy, start the service. On start, `#migrate()` runs any migrations
newer than the backup's stored `user_version`, so restoring an older backup onto a newer code
version applies forward migrations automatically; there is no down-migration path if that's not
wanted. No ordering constraint with other services' data — `atc-flags` history and state are entirely
self-contained (flag keys are opaque strings to the rest of the platform, not foreign keys into
another service's data).

## Metrics
`GET /metrics` (Prometheus text, `read`-role key required):
- `flags_total{state="active"|"archived"}` — durable, read from `flags` table counts.
- `flags_enabled{env}` — durable, read from `flag_envs` table counts.
- `flags_env_version{env}` — durable, read from `env_versions` table (same counter that backs the
  snapshot `ETag`).
- `flags_evaluations_total{env}` — **process-local counter**, `FlagService.evaluations` (an
  in-memory `Map`, incremented on every `evaluate()` call); resets to 0 on every restart, not
  backed by the database. `GET /v1/stats`'s `evaluations` field is the same counter.
- `flags_process_uptime_seconds` — process-local (`process.uptime()`), resets on restart.

## Logging
Fastify's default request logger is active (`requestIdHeader: 'x-request-id'`, `genReqId:
randomUUID`), so every log line carries `reqId` per the vocabulary in
[OBSERVABILITY.md](../../atc-stack/docs/OBSERVABILITY.md), and `req.headers.authorization` is redacted.
Fields this service does **not** yet emit: `traceId`, `spanId`, `route`/`op` (Fastify logs the raw
`req.url`, not a normalised operation name), `durationMs` (Fastify's default field is
`responseTime`, same idea, different name), `upstream`/`upstreamMs` (flags makes no proxied
upstream call in the request path), `service`, `version`. `code` appears in every JSON error body
(`{ error: { code, message } }`) but is only additionally logged for 500s, via the generic `err`
object passed to `request.log.error({ err }, 'unhandled error')` — it is not a separate structured
field on every log line.

## Tracing
`atc-flags` accepts whatever `X-Request-Id` its caller sends (`requestIdHeader: 'x-request-id'`, no
trust gate — per [OBSERVABILITY.md](../../atc-stack/docs/OBSERVABILITY.md) this is an internal service
reached only from gateway, console or peer services, never directly from an untrusted client) and
generates one (`randomUUID()`) when absent. Also parses an inbound `traceparent` via
`@atc-web/atc-service-core`'s `registerRequestContext`, trust-gated on the same `TRUST_PROXY` flag:
trusted, the caller's trace-id is continued with a fresh span-id; untrusted or malformed, a fresh
trace is started. Both `traceId`/`spanId` are logged on every request line. `atc-flags` makes no
outbound HTTP calls in the request path (the audit call is asynchronous, off the request path, and
does not forward any request-scoped header) so there is nothing to propagate onward today either
way.

## Security model
Bearer API keys (`FLAGS_API_KEYS=id:secret[:role[:envs]]`), each compared to the presented secret
via SHA-256 + `timingSafeEqual` (`ApiKeyAuth.#secretsEqual`) so a match takes constant time
regardless of which or whether a key matched. Roles: `read`, `write`, `readwrite` (default),
enforced per-route (`ApiKeyAuth.require`). Environment scoping: a key's `envs` list (or `null` for
all) is enforced on every route that names an environment, including what a flag's environment
list reveals in list/get responses (`#visibleEnvs`); a scoped key additionally cannot `DELETE` a
flag at all (checked explicitly in the delete handler). No secret rotation support: rotating a key
means editing `FLAGS_API_KEYS` and restarting the process — there is no live key add/remove, no
expiry, no multiple-active-secrets-per-id overlap window. At the boundary: request bodies are
schema-validated (Fastify + ajv, `removeAdditional: false` so unknown fields are rejected rather
than silently stripped), values/rules are checked against the flag's declared `kind` and size caps.
Out of scope: authenticating end users of the application calling `atc-flags` (that's the caller's
job — `atc-flags` only authenticates the calling service/key), TLS certificate rotation (manual: replace
`TLS_CERT_PATH`/`TLS_KEY_PATH` files and restart).

## Scaling model
**B — single-node stateful**: one process owns one SQLite file. `ecosystem.config.cjs` pins
`instances: 1` with the comment "one process per SQLite file" — this is a deliberate, configured
constraint, not an accident. Two instances pointed at the same file would not be safe as currently
built: even though `node:sqlite`'s WAL mode plus `busy_timeout` gives the *database* itself
process-safe concurrent access, `FlagService` keeps a per-process, version-keyed in-memory
evaluation cache (`this.cache`) and per-process evaluation counters (`this.evaluations`, the source
of `flags_evaluations_total`) that would silently diverge between two processes — each would report
different `/v1/stats` and `/metrics` numbers, and there is no cross-process cache invalidation
beyond each process's own `env_versions` polling.

## Single-node / multi-node guarantees
Running more than one `atc-flags` instance against the same `DB_PATH` today is unsupported and
untested: writes themselves would likely stay consistent (SQLite's own locking), but each instance
would serve its own independent evaluation cache and its own independent `evaluations`/`/metrics`
counters, so two instances behind a load balancer would show different stats and could momentarily
disagree by up to one `#states()` cache refresh cycle (bounded by how quickly each process notices
the `env_versions` counter changed, which is immediate — the cache key is the version itself, not
time-based, so a stale read only happens for the request that's already in flight when the write
commits). There is no distributed cache invalidation, no shared-memory coordination, and no leader
election; the topology this repository ships (`ecosystem.config.cjs`, `instances: 1`) is the only
one that has been exercised.

## Known failure modes
- **Disk full**: a write inside `db.transaction()` throws, the transaction is rolled back
  (`ROLLBACK`), and the request fails with a `500 INTERNAL_ERROR` (or whatever SQLite's own error
  surfaces as); the flag store is left in its pre-write state since every mutation goes through
  `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`.
- **Audit service times out or is unreachable mid-request**: no effect on the flags request itself
  — `AuditClient.record()` only pushes to an in-memory array synchronously; the network call happens
  later, off a timer. If audit stays down long enough, buffered events are dropped once
  `MAX_BUFFER = 5_000` is hit (oldest first, with a warning log), and any events still buffered when
  the process exits ungracefully are lost (no on-disk queue).
- **Process killed without a graceful shutdown** (`SIGKILL`, OOM under `max_memory_restart`): any
  audit events sitting in the in-memory buffer are lost; the SQLite file itself should remain
  consistent because commits are atomic (WAL), but the in-flight request being served at the moment
  of the kill gets no response.
- **Two instances run against one file**: unsupported configuration (see Scaling model above) —
  the repository does not test or guard against it; each process's evaluation cache and metrics
  counters would diverge silently, with no error raised.
- **Example/implementation drift**: `examples/snapshots.md`'s `LocalFlags.evaluate()` hand-copies
  the same decision logic as `src/domain/evaluator.js`'s `Evaluator.evaluate`/`matches` (disabled →
  offValue, rule match, percentage bucket via `SHA-256(salt:id) mod 10000`) as a documentation
  example for client SDKs, rather than importing `Evaluator`. `Evaluator` itself is a small,
  dependency-free, trivially copyable module (only `node:crypto`), which is presumably why the
  example re-implements it inline — but nothing keeps the two in sync: a future change to
  `Evaluator`'s rule-matching or bucketing logic would not be reflected in the example unless
  someone remembers to update it by hand.
