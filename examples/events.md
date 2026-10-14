# Events

```bash
WEBHOOK_OUT_URL=http://webhook-out.internal:3009
WEBHOOK_OUT_API_KEY=<a webhook-out key with the publish role>
```

| Event | When | Data |
|---|---|---|
| `flag.changed` | A flag is created, updated, archived, reshuffled, deleted; an environment state is changed or copied | `key`, `env` (null for flag-level changes), `action` (`flag.create`, `flag.update`, `flag.delete`, `env.update`, `env.copy`), `actor`, and for environment changes `enabled`, `percentage` |

Subscribe a service endpoint to `flag.changed` in atc-webhook-out and refetch the snapshot (`GET /v1/snapshot/:env`, `If-None-Match`) when it fires, instead of polling on a timer. The event carries no flag values: read them through the API with the key you already hold.

The event goes out after the change is stored. It is best effort (in-memory queue, retries, no durability across a restart), so keep a slow poll as a safety net.

Pitfalls:
- The event is published per change, not per saved form; a script that updates ten flags sends ten events.
