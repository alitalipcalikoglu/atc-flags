# Operations

## Probes

```bash
curl -s $FLAGS/health   # {"status":"ok"}
curl -s $FLAGS/ready    # {"status":"ok"} when SQLite answers; 503 otherwise (cached 10 s)
```

## Metrics

```bash
fcurl $FLAGS/metrics
```

```
flags_total{state="active"} 42
flags_total{state="archived"} 7
flags_enabled{env="prod"} 30
flags_env_version{env="prod"} 913
flags_evaluations_total{env="prod"} 188120
flags_process_uptime_seconds 86400
```

`flags_evaluations_total` counts evaluation requests (not flags) since the process started.

## Environment

Required: `FLAGS_API_KEYS`. `FLAGS_ENVIRONMENTS` defaults to `dev,staging,prod`. Full list: [.env.example](../.env.example).

Adding an environment later: append it to `FLAGS_ENVIRONMENTS` and restart. Existing flags have no state there yet; `GET /v1/flags/:key/envs/<new>` answers `404` until each flag is copied into it (`POST …/envs/staging/copy {"to":"<new>"}`). Removing an environment from the list hides it; its rows stay in the database.

## Process manager

```bash
cp .env.example .env && $EDITOR .env
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 reload flags
```

`kill_timeout` is 35 s; SIGTERM stops accepting connections, finishes in-flight requests, closes the database.

## Docker

```bash
docker build -t atc-flags .
docker run -d -p 3007:3007 -v atc-flags-data:/data --env-file .env atc-flags
```

## Logs

JSON lines. `Authorization` is redacted. Evaluation requests log at `info` like any request; on a busy instance set `LOG_LEVEL=warn`.

## Backups

```bash
sqlite3 data/flags.db ".backup 'flags-$(date +%F).db'"
```

The database holds every state and the full history; there is nothing else to back up.

## Failure mode for applications

Applications must treat the service as optional: cache the last answer (or snapshot) and fall back to a safe default when it is unreachable. The examples' clients do that. Never block a request on the flag service.
