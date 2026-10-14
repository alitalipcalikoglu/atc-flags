# Turning a flag on

Every environment has its own state: `enabled`, `value`, `offValue`, `percentage`, `rules`. `PATCH /v1/flags/:key/envs/:env` changes any subset.

```bash
fcurl -X PATCH $FLAGS/v1/flags/checkout.new/envs/staging -d '{"enabled":true}'
```

```json
{ "env": "staging", "state": { "enabled": true, "value": true, "offValue": false, "percentage": 100, "rules": [], "version": 2, "updatedBy": "atc-console", "updatedAt": "…" } }
```

From this moment `GET /v1/evaluate?env=staging` returns `"checkout.new": true`; `prod` still returns `false`.

## What is served when

| Situation | Served |
|---|---|
| `enabled: false` | `offValue` (the kill switch; rules and percentages are ignored) |
| `enabled: true`, a rule matches | that rule's `value` |
| `enabled: true`, inside the rollout | `value` |
| `enabled: true`, outside the rollout | `offValue` |

For a boolean flag `value` is normally `true` and `offValue` `false`. For settings both are meaningful: `value` is the setting when on, `offValue` the safe fallback.

## Promoting staging to prod

Copy a whole state, rules and percentage included:

```bash
fcurl -X POST $FLAGS/v1/flags/checkout.new/envs/staging/copy -d '{"to":"prod"}'
```

The response is prod's new state; history records `env.copy` with `from: "staging"`.

## Turning off quickly

```bash
fcurl -X PATCH $FLAGS/v1/flags/checkout.new/envs/prod -d '{"enabled":false}'
```

One field, one request. Applications that evaluate on the server see it on their next call; snapshot clients on their next poll (see [snapshots](snapshots.md)).

## Versions

Each state carries a `version` that grows with every change, and each environment has a counter (`GET /v1/environments`) that grows with any change in that environment. The environment counter is what the snapshot ETag and the `X-Flags-Version` header expose.
