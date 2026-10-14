# Change history

Every write is recorded with the API key that made it, the environment (when relevant) and the state before and after.

```bash
fcurl "$FLAGS/v1/flags/checkout.new/history?limit=3"
```

```json
{
  "items": [
    { "id": 41, "key": "checkout.new", "env": "prod", "action": "env.update", "actor": "atc-console",
      "before": { "enabled": true, "value": true, "offValue": false, "percentage": 10, "rules": [] },
      "after":  { "enabled": true, "value": true, "offValue": false, "percentage": 50, "rules": [] }, "at": "2026-09-16T12:00:00.000Z" },
    { "id": 38, "key": "checkout.new", "env": "prod", "action": "env.copy", "actor": "atc-console", "before": { "…": "…" }, "after": { "from": "staging", "…": "…" }, "at": "…" },
    { "id": 12, "key": "checkout.new", "env": null, "action": "flag.create", "actor": "deployer", "before": null, "after": { "kind": "boolean", "…": "…" }, "at": "…" }
  ],
  "nextBefore": "12"
}
```

Actions: `flag.create`, `flag.update` (description, tags, archived, reshuffle), `flag.delete`, `env.update`, `env.copy`. Paging with `before=<id>`.

Across all flags, newest first:

```bash
fcurl "$FLAGS/v1/history?limit=50"
```

## Answering "what changed at 12:00?"

History plus the environment version: every entry bumps the environment counter, and applications log `X-Flags-Version` with their evaluations. Match the version an application saw with the entries before it.

## Retention

`HISTORY_RETENTION_DAYS` (default 365). Flags and states are never purged.
