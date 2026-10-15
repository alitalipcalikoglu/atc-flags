# Approvals for production (two-person rule)

Set `PROTECTED_ENVS=prod` (any of `FLAGS_ENVIRONMENTS`, comma separated). From then on a change to a protected environment's state is not applied right away:

```bash
curl -s -X PATCH $FLAGS/v1/flags/checkout.new/envs/prod -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"percentage":10}'
```

```json
{ "change": { "id": "chg_…", "key": "checkout.new", "env": "prod", "kind": "update", "payload": { "enabled": true, "percentage": 10 }, "status": "pending", "requestedBy": "console/ada", "requestedAt": "…" } }
```

Status `202`. The patch is validated now (`400` for a wrong value), recorded in the flag's history as `change.requested`, and nothing changes in prod. A copy onto a protected environment (`POST /v1/flags/:key/envs/staging/copy {"to":"prod"}`) becomes a request of kind `copy` the same way, with a snapshot of the source state in its payload (`{ from, fromVersion, state }`): approving applies exactly that snapshot, never the source as it is at approval time.

## Approving

```bash
curl -s $FLAGS/v1/changes?status=pending -H "Authorization: Bearer $KEY"
curl -s -X POST $FLAGS/v1/changes/chg_…/approve -H "Authorization: Bearer $OTHER_KEY"
```

`200` with the applied state. The approver must be a different actor than the requester (`403 SELF_APPROVAL`). For a copy the approver needs access to both environments: a key scoped away from the source gets `403 FORBIDDEN`. Actors are API key ids; a key listed in `ACTOR_KEYS` (the admin console) can name the person in `X-Actor`, so two people using the console count as two actors (`console/ada`, `console/grace`). The history shows the approver and the request.

If the environment — or, for a copy, the source environment — changed after the request was made (another approval, an unprotected path), the approval fails with `409 CHANGE_STALE` and the request is closed: nobody applies something they did not review. Request it again.

## Rejecting

```bash
curl -s -X POST $FLAGS/v1/changes/chg_…/reject -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"note":"not before the release"}'
```

Anyone with a write key may reject, including the requester (withdraw). Closed requests answer `409 CHANGE_CLOSED`.

## Pitfalls

- Creating, archiving and deleting a flag are not gated (a new flag starts off; delete removes it everywhere). Keep delete rights on few keys.
- Without `ACTOR_KEYS`, everyone using the console is one actor (the console key) and could never approve their colleagues' requests.
- Evaluation and snapshots never show pending requests.
