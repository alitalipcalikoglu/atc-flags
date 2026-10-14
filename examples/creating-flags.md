# Creating flags

```bash
fcurl -X POST $FLAGS/v1/flags -d '{"key":"checkout.new","kind":"boolean","description":"New checkout flow","tags":["checkout","q4"]}'
```

```json
{
  "flag": {
    "key": "checkout.new", "kind": "boolean", "description": "New checkout flow", "tags": ["checkout", "q4"], "archived": false,
    "createdBy": "atc-console", "createdAt": "2026-09-16T10:00:00.000Z", "updatedAt": "2026-09-16T10:00:00.000Z",
    "environments": {
      "dev":     { "enabled": false, "value": true, "offValue": false, "percentage": 100, "rules": [], "version": 1, "updatedBy": "atc-console", "updatedAt": "…" },
      "prod":    { "enabled": false, "value": true, "offValue": false, "percentage": 100, "rules": [], "version": 1, "updatedBy": "atc-console", "updatedAt": "…" },
      "staging": { "enabled": false, "value": true, "offValue": false, "percentage": 100, "rules": [], "version": 1, "updatedBy": "atc-console", "updatedAt": "…" }
    }
  }
}
```

`201 Created`, `Location: /v1/flags/checkout.new`. A flag exists in every environment from the start, **disabled**: creating a flag never changes what applications see until someone enables it somewhere.

## Kinds

| `kind` | `value` / `offValue` accept | Default `value` | Default `offValue` | Typical use |
|---|---|---|---|---|
| `boolean` | `true` / `false` | `true` | `false` | Feature on/off, kill switch |
| `string` | any string | `""` | `""` | Banner text, provider name, variant label (`"A"`, `"B"`) |
| `number` | finite number | `0` | `0` | Limits, timeouts, prices |
| `json` | any JSON value (objects, arrays, null) | `null` | `null` | Structured settings |

Initial values for every environment can be given at creation: `{"key":"search.limit","kind":"number","value":50,"offValue":10}`; `enabled: true` switches every environment on immediately (use for settings that must exist everywhere).

## Keys

Lower-case segments separated by `.`, `-` or `_`: `checkout.new`, `search-limit`, `billing.retry_days`. At most 80 characters. Keys are permanent: applications reference them in code, so rename by creating a new flag and archiving the old one.

## Tags and description

Tags are lower-cased, de-duplicated and sorted; filter lists by them (`GET /v1/flags?tag=checkout`). Description is free text up to 500 characters; write who owns the flag and when it can be removed.

## Editing metadata

```bash
fcurl -X PATCH $FLAGS/v1/flags/checkout.new -d '{"description":"New checkout flow (owner: payments)","tags":["checkout","q4","payments"]}'
```

`PATCH /v1/flags/:key` changes `description`, `tags`, `archived` and `reshuffle` only; environment states have their own endpoint (see [enabling](enabling.md)).

## Archiving and deleting

```bash
fcurl -X PATCH $FLAGS/v1/flags/checkout.new -d '{"archived":true}'   # disappears from evaluations and snapshots, keeps history
fcurl -X DELETE $FLAGS/v1/flags/checkout.new                          # 204; states go with it, history stays
```

Archive first. Applications still calling an archived flag get `null` with reason `missing` (when they ask for it by key), which is the same as a deleted flag but reversible. Delete once the code that reads the flag is gone. Environment-scoped keys cannot delete.

## Errors

| Status | Code | Cause |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Shape violated; unknown fields rejected. |
| 400 | `INVALID_VALUE` | Key pattern, or a value that does not fit the kind. |
| 409 | `FLAG_EXISTS` | Key already in use. |
| 413 | `VALUE_TOO_LARGE` | A value above `MAX_VALUE_BYTES`. |
