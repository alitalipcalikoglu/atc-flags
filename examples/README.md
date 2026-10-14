# flags examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `FLAGS_API_KEYS`. Base URL below is `http://localhost:3007`; environments are the default `dev`, `staging`, `prod`.

| Example | Shows |
|---|---|
| [Creating flags](creating-flags.md) | Kinds (boolean, string, number, json), keys, tags, what every environment starts with |
| [Turning a flag on](enabling.md) | Enable per environment, `value` vs `offValue`, promoting staging to prod |
| [Percentage rollouts](rollouts.md) | Gradual release, stable buckets, why raising never flips a user back, reshuffling |
| [Targeting rules](targeting.md) | Users, emails, attributes; rule order; internal testers before everyone |
| [Evaluating in an application](evaluating.md) | Server-side evaluation (GET/POST), context, details and reasons, version header |
| [Client-side evaluation with snapshots](snapshots.md) | Cached rule sets with ETag, evaluating locally, a 60-line client |
| [Typed settings](settings.md) | Using string/number/json flags as remote configuration |
| [Change history](history.md) | Who changed what and when, per flag and globally |
| [API keys, roles and environments](keys-and-roles.md) | Read, write, readwrite; scoping a key to one environment |
| [Operations](operations.md) | Health, readiness, metrics, environment, PM2, Docker, retention |
| [Events](events.md) | `flag.changed` through atc-webhook-out |
| [Audit events](audit-events.md) | Which write actions are forwarded to the audit service, event shape, configuration |

Set up once for the examples:

```bash
export FLAGS=http://localhost:3007
export KEY=<a readwrite secret from FLAGS_API_KEYS>
alias fcurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```
