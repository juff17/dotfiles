# Context and scale

Decide whether the work is greenfield or brownfield, then estimate the scale it
has to handle. The answer changes how much the spec cares about load, and how
closely it must follow existing conventions.

## Greenfield vs brownfield

| | Greenfield | Brownfield |
|---|---|---|
| Signal | Empty or new repo, no deployed infra, no existing API or schema for this area | Existing code, schema, API, and deployed infra the work must fit into |
| Conventions | Choose them (defaults in [`api.md`](api.md) and [`types-naming.md`](types-naming.md)) and write them down | Follow what exists, even where the defaults differ. Note a convention you'd change as an open question, don't change it silently |
| Scale | Rarely the constraint. Design for launch, keep it simple | A real constraint. Estimate it from infra (below) |
| Data | New tables, free choice of shape | Prefer adding to existing tables; plan migrations (see [`data.md`](data.md)) |
| Risk | Over-building | Breaking existing callers, slow migrations on large tables, load on shared resources |

Work can be mixed: a new service inside an existing platform is greenfield for
its own code and brownfield for the platform's auth, data, and infra.

## Estimating scale in brownfield

Read the infra and config as they are today. They show what the team provisioned
for, which is the best evidence of real load short of metrics.

| Where to look | What it tells you |
|---|---|
| Terraform, Pulumi, CloudFormation, Helm values, k8s manifests | Instance types and counts, container CPU and memory, replica counts |
| Autoscaling config (ASG min/max, HPA min/max and targets) | Normal load (min) and expected peak (max) |
| Database resources (RDS/Cloud SQL class, storage size, read replicas, connection pool size) | Data volume and read/write pressure |
| Queue and worker config (worker count, concurrency, visibility timeout, prefetch) | Background job throughput |
| Rate limits (API gateway, WAF, app middleware) | Requests per client the team expects to allow |
| CDN and cache config (CloudFront, Fastly, Redis size, TTLs) | Read-heavy traffic, which responses are cached |
| Env and feature-flag config per environment | Which features are live, and differences between staging and prod |
| Dashboards, alerts, SLO files in the repo | Actual traffic numbers and latency targets, when present |

Turn it into a short estimate in the spec:

- **Size class**: roughly how many users or requests (e.g. "a few hundred
  concurrent users", "tens of requests per second at peak").
- **Evidence**: the files and values it came from, e.g. "2 to 6 API pods
  (HPA in `deploy/api/values.yaml`), one `db.t4g.medium` with no replica".
- **What it means for this design**: e.g. "a 5-second poll from every open
  page adds about N requests per second; fine at this size".

**State it as an assumption and ask the user to confirm it** before designing
around it. Infra can be over-provisioned or out of date, and the user may know
the real numbers.

If there is no infra in the repo, say so and ask the user for the expected
user base. Don't guess one.

## Estimating scale in greenfield

- Ask the user for the expected users at launch and in the first year.
- Design for launch. Note in non-goals what would change at the larger number,
  so the design doesn't block it (see [`principles.md`](principles.md)).
