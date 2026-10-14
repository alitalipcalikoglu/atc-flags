# atc-flags

Feature flags and typed settings for applications: one state per environment, on/off, percentage rollouts with stable per-user buckets, targeting rules on users, emails and attributes, change history, and cached snapshots for client-side evaluation. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`. Storage is SQLite via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # set FLAGS_API_KEYS (and FLAGS_ENVIRONMENTS if not dev,staging,prod)
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-flags .
docker run -p 3007:3007 -v atc-flags-data:/data --env-file .env atc-flags
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **A flag** has a `key` (`checkout.new`), a `kind` (`boolean`, `string`, `number`, `json`), description, tags, and an `archived` bit. Creating a flag creates a **disabled** state in every environment.
- **A state** (per environment): `enabled`, `value`, `offValue`, `percentage` (0–100), `rules`. Served value: disabled → `offValue`; first matching rule → its value; inside the rollout → `value`; otherwise `offValue`.
- **Rollout buckets** are `SHA-256(flagSalt:userId) mod 10000`: stable per user, raising the percentage never removes anyone, `reshuffle` draws new buckets.
- **Rules** match `userIds`, `emails` (case-insensitive) and `attrs` (every listed attribute must match), in order.
- **Versions**: each state has a version; each environment has a counter bumped by any change, exposed as the snapshot `ETag` and the `X-Flags-Version` header.
- **Keys** are `id:secret[:role[:envs]]`: roles `read` / `write` / `readwrite`; an environment scope hides and protects every other environment.
- **History** records every write with actor, before and after.

## Boundaries

**Purpose:** feature flag evaluation with targeting and percentage rollout.

**Responsibilities:** flag/environment CRUD; deterministic salted-bucket evaluation; environment snapshot with ETag; change history.

**Non-responsibilities:** not an experimentation/analytics platform — no exposure logging or statistical analysis, just the evaluation decision. Not a general settings/config store, only boolean/variant flags.

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness; readiness (database, cached 10 s); service identity (version, API version, capabilities, schema version, service-core version). |
| GET | `/v1/environments` | read | Visible environments with their version counters. |
| POST | `/v1/flags` | write | `{ key, kind, description?, tags?, value?, offValue?, enabled? }` → `201 { flag }` with every environment. |
| GET | `/v1/flags` | read | Sorted by key; `q`, `tag`, `kind`, `archived`, `limit` ≤ 200, `cursor`. |
| GET / PATCH / DELETE | `/v1/flags/:key` | read / write / write | Read; `{ description?, tags?, archived?, reshuffle? }`; delete (not for scoped keys). |
| GET | `/v1/flags/:key/history`, `/v1/history` | read | Changes, newest first (`limit`, `before`). |
| GET / PATCH | `/v1/flags/:key/envs/:env` | read / write | One environment's state; `{ enabled?, value?, offValue?, percentage?, rules? }`. |
| POST | `/v1/flags/:key/envs/:env/copy` | write | `{ to }`: copy the state to another environment. |
| GET | `/v1/evaluate` | read | `env`, `userId`, `email`, `attrs.<name>`, `keys` (comma list), `details` → `{ env, version, flags }`. |
| POST | `/v1/evaluate` | read | `{ env, context?, keys?, details? }`, same result. |
| GET | `/v1/snapshot/:env` | read | Full rule set with `ETag` for local evaluation; `304` on `If-None-Match`. |
| GET | `/v1/stats` | read | Flag counts, per environment: version, enabled count, evaluations since start. |
| GET | `/metrics` | read | Prometheus text. |

Error codes: `FLAG_NOT_FOUND`, `FLAG_EXISTS`, `UNKNOWN_ENV`, `INVALID_VALUE`, `INVALID_RULE`, `VALUE_TOO_LARGE`, `INVALID_CURSOR`, `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`.

### From a backend

```js
const res = await fetch(`${process.env.FLAGS_URL}/v1/evaluate`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.FLAGS_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ env: 'prod', context: { userId: user.id, email: user.email, attrs: { plan: user.plan } } }),
});
const { flags } = await res.json();
if (flags['checkout.new'] === true) return renderNewCheckout();
```

Cache answers and fall back to safe defaults when the service is unreachable; a buffered client and a snapshot-based local evaluator are in [examples/](examples/README.md).

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md).

## Configuration

All settings come from environment variables and are validated at startup. See [.env.example](.env.example). Required: `FLAGS_API_KEYS`.

## Security notes

- API keys compared in constant time; per-key rate limit; read/write roles; environment scoping enforced on every endpoint that names an environment, including what a flag object reveals.
- Values are validated against the flag's kind and capped at `MAX_VALUE_BYTES`; rule lists are bounded; unknown fields rejected; bodies capped at `BODY_LIMIT`.
- No secrets belong here: every read key can see every value in its environments. Settings are configuration, not credentials.
- Every write is attributed to the key that made it and kept in history.
- `Cache-Control: no-store` on every response except the snapshot (`must-revalidate` with a strong ETag); `X-Content-Type-Options: nosniff`.
- Container runs as the unprivileged `node` user.

## Code layout

Class-based; dependencies are injected through constructors, `src/application.js` is the composition root.

| Class | File | Role |
|---|---|---|
| `Application` | `src/application.js` | Wiring, startup, graceful shutdown |
| `Config` | `src/config.js` | Validated environment, key roles and scopes |
| `Database` | `src/db.js` | SQLite connection, migrations, transactions |
| `FlagStore`, `HistoryStore` | `src/store/` | Flags, states, environment versions, change log |
| `FlagService` | `src/domain/flag-service.js` | Lifecycle, states, evaluation with a version-keyed cache, snapshots |
| `Evaluator` | `src/domain/evaluator.js` | Decision order and rollout buckets |
| `ValueCheck`, `FlagError` | `src/domain/` | Kind and rule validation, errors |
| `FlagsApi`, `ApiKeyAuth`, `Schemas`, `Views` | `src/http/` | Fastify routes, roles and scopes, shapes |
| `Maintenance` | `src/maintenance.js` | Hourly history retention |

## Out of scope by design

- Multivariate experiments with metrics: a `string` flag serves the variant; measure in your analytics.
- Scheduled changes ("enable at 09:00"): the [atc-scheduler](https://github.com/alitalipcalikoglu/atc-scheduler) service calls `PATCH …/envs/:env` at the right time; see its `examples/flags-scheduled-change.md`.
- Per-subscriber delivery of changes: the service publishes `flag.changed` to atc-webhook-out, which owns subscriptions, signing and retries. Polling the snapshot with `If-None-Match` stays the cheapest way for an SDK.
- Numeric or regex conditions in rules: bucket values into strings on the application side.
- Per-flag permissions inside one environment: use separate environments or separate instances.

## Events

With `WEBHOOK_OUT_URL` set, every flag or environment change publishes `flag.changed` (key, env, action, actor; never values). Best effort; see [examples/events.md](examples/events.md).

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## Scaling model

**B — single-node stateful.** One process owns one SQLite file (`ecosystem.config.cjs` pins `instances: 1`). Beyond the database
itself, `FlagService` keeps a per-process evaluation cache and per-process evaluation counters
(the source of `/metrics` and `/v1/stats`), so two instances against the same `DB_PATH` would serve
correct data but disagree with each other on stats — this topology is not tested or supported. See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

## Observability

Requests are logged with `reqId` (accepts or generates `X-Request-Id`) and `traceId`/`spanId` (a
trusted inbound `traceparent`, gated on `TRUST_PROXY`, continues the caller's trace with a fresh
span-id for this hop; see [OBSERVABILITY.md](../atc-stack/docs/OBSERVABILITY.md)). `/health` is a static check; `/ready` pings the database, cached for
10s, and never mutates state. See [docs/READINESS.md](docs/READINESS.md) for the full contract.

Event publishing is observable as `events_publish_enabled`, `events_publish_total{result="published|sent|dropped|failed"}` and `events_publish_pending`.

Audit forwarding is observable too: `audit_forward_enabled`, `audit_forward_events_total{result="recorded|sent|dropped|failed"}` and `audit_forward_pending`. A rising `dropped`, or a `pending` that does not drain, means audit events are being lost or delayed; alert on it.

## Backup / restore

The only state to protect is the SQLite file at `DB_PATH` (default `./data/flags.db`, plus its WAL
sidecars while running) — configuration is environment variables, not data. Use `stack backup`/
`stack restore` from the workspace root (see `atc-stack/docs/UPGRADE.md`) to snapshot and restore this
consistently alongside the rest of the stack. On every start, before applying a pending migration
to an existing database, the service itself also snapshots the file to
`DB_PATH.pre-v<N>-<timestamp>` (directory overridable with `DB_BACKUP_DIR`) — a manual last resort
if `stack restore` is unavailable.

**Rollback limitations:** none of the migrations are reversible; to roll back, restore the
pre-migration copy (or a `stack backup` snapshot taken before the upgrade) and run the previous
version of this service against it. See [docs/READINESS.md](docs/READINESS.md) for the full
contract.

## License

MIT, see [LICENSE](LICENSE).
