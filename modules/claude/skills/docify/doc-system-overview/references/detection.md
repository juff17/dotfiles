# Detection patterns

Catalog of patterns the main agent and subagents use to detect what kind of subsystems a repo has, and where to look for them. Read whichever sections are relevant to the task at hand — don't read top-to-bottom.

## API frameworks

Look for these signals to confirm the repo serves an API:

| Language / framework | Signals |
|---|---|
| Node Express / Fastify | `app.get`, `app.post`, `router.get`, `app.use(...)`, `import express`, `import fastify` |
| Node NestJS | `@Controller`, `@Get`, `@Post` decorators; `nest-cli.json` |
| Python FastAPI | `@app.get`, `@router.get`, `from fastapi import`; `app = FastAPI(...)` |
| Python Flask | `@app.route`, `from flask import Flask` |
| Python Django | `urls.py`, `path(...)`, `re_path(...)` |
| Java/Kotlin Spring | `@RestController`, `@RequestMapping`, `@GetMapping` |
| Ruby on Rails | `config/routes.rb` |
| Go | `http.HandleFunc`, `chi.Router`, `gin.Engine`, `echo.New` |
| Elixir Phoenix | `lib/*_web/router.ex` |
| .NET | `[ApiController]`, `[Route]` |

If you find route registrations, you have an API. Note the file(s) where routes are defined — those are the entry points for the api-investigator.

## Swagger / OpenAPI locations

Point to these instead of duplicating their content:

- `openapi.{yaml,json}` or `openapi/**` directory
- `swagger.{yaml,json}` or `swagger/**`
- `docs/api.{yaml,json}`
- FastAPI auto-docs at `/docs` and `/redoc` (mention the paths, no file)
- NestJS Swagger module: `SwaggerModule.setup(...)` — look in `main.ts` or wherever bootstrap happens
- springdoc / springfox annotations on controllers
- `tsoa.json` config + generated `swagger.json`

When Swagger is served at runtime (FastAPI's `/docs`, NestJS Swagger module, springdoc UI, etc.) the actual URL depends on where the app runs locally. Check `docker-compose.yml`, `Dockerfile`, and the README for the host and port the service binds to — the URL is something like `http://localhost:8000/docs`, not `/docs` in isolation. Report the full localhost URL.

If no Swagger is found, say so in the Endpoints section instead of pointing to a non-existent file.

## Databases / ORMs

Signals that confirm a DB is present:

| Stack | Signals |
|---|---|
| Prisma | `schema.prisma`, `prisma/migrations/` |
| SQLAlchemy | `from sqlalchemy import`, `Base = declarative_base()`, `models.py` with `Base` subclasses |
| Django ORM | `models.py` with `class X(models.Model)`, `migrations/` directories under apps |
| TypeORM / Sequelize | `@Entity` decorators, `models/` with class-per-entity |
| Drizzle (Node) | `drizzle.config.ts`, `db/schema.ts` with `pgTable`/`mysqlTable` |
| GORM (Go) | structs with ``gorm:"..."`` tags |
| ActiveRecord (Rails) | `db/schema.rb`, `app/models/*.rb` inheriting `ApplicationRecord` |
| Diesel (Rust) | `diesel.toml`, `src/schema.rs` |
| Ecto (Elixir) | `lib/*/schema.ex`, `migrations/` |
| MongoDB / Mongoose | `mongoose.Schema`, `@nestjs/mongoose` |
| Raw SQL | `migrations/` or `db/migrate/` directories with `.sql` files |

Tell the data-investigator the schema/model file paths it found, so it can start there rather than re-search.

## LLM usage

Signals that the service uses LLMs:

- **Imports**: `anthropic`, `@anthropic-ai/sdk`, `openai`, `@openai/api`, `litellm`, `langchain`, `langgraph`, `llamaindex`, `llama-index`, `instructor`, `vercel/ai`, `ai-sdk`, `cohere`, `@google/generative-ai`, `replicate`
- **Filename hints**: directories named `prompts/`, `prompt_templates/`, `llm/`, `ai/`. Files named `*_prompt.{py,ts}`, `*_prompts.{py,ts}`, `system_prompt.*`, `*_chain.{py,ts}`
- **Env vars**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`
- **String literal hints**: long strings beginning with `"You are..."`, `"You will..."`, `"<task>"`, often hundreds of tokens

If at least two signals match, treat LLM usage as confirmed and spawn `llm-investigator`.

## Queues / async messaging

Signals that the service moves work off the request path via task queues, pub/sub, or scheduled jobs:

### Task queue libraries

| Stack | Signals |
|---|---|
| BullMQ / Bull (Node) | `import { Queue, Worker, QueueScheduler } from 'bullmq'`, `new Bull(...)`, repeatable-job options |
| Celery (Python) | `from celery import`, `@app.task`, `.delay(...)`, `.apply_async(...)` |
| Sidekiq (Ruby) | `include Sidekiq::Job`, `perform_async`, `sidekiq.yml` |
| RQ (Python) | `from rq import Queue`, `queue.enqueue(...)` |
| Resque (Ruby) | `Resque.enqueue(...)`, `@queue = :name` |
| AWS SQS | `@aws-sdk/client-sqs`, `boto3.client("sqs")`, `SendMessageCommand` |
| GCP Pub/Sub (as queue) | `@google-cloud/pubsub`, `PublisherClient`, `SubscriberClient` |
| Azure Service Bus | `@azure/service-bus`, `ServiceBusClient` |
| Google Cloud Tasks | `@google-cloud/tasks`, `CloudTasksClient` |
| Inngest | `import { Inngest }`, `inngest.createFunction(...)` |
| Temporal | `@temporalio/client`, `@temporalio/worker`, `proxyActivities` |
| river (Go) | `import "github.com/riverqueue/river"`, `river.NewClient` |
| NestJS Bull | `@nestjs/bull`, `@Processor`, `@Process` decorators |

### Pub/sub & event-bus signals

- **Kafka**: `kafkajs`, `confluent-kafka`, `kafka-python`, `@nestjs/microservices` Kafka transport
- **RabbitMQ / AMQP**: `amqplib` (Node), `pika` (Python), `bunny` (Ruby), `@nestjs/microservices` RMQ transport
- **Redis pub/sub**: `redis.publish(...)` / `.subscribe(...)`, `ioredis` pub/sub patterns (distinct from BullMQ usage of Redis)
- **NATS**: `nats.connect(...)`, `nats-py`
- **MQTT**: `mqtt.connect(...)`, `paho-mqtt`
- **In-process buses**: `EventEmitter` / `EventBus` patterns when used as a primary integration mechanism (not just for one-off listeners)

### Scheduled-job signals

- `node-cron`, `node-schedule`, `cron` (Node)
- BullMQ repeatable jobs (`{ repeat: { cron: '...' } }`)
- Celery Beat (`beat_schedule`, `CELERYBEAT_SCHEDULE`)
- `whenever` gem, `rufus-scheduler` (Ruby)
- `@nestjs/schedule` — `@Cron`, `@Interval`, `@Timeout` decorators
- Quartz (Java/Kotlin)
- Kubernetes `CronJob` manifests in `k8s/` or `deploy/`
- GitHub Actions `schedule:` triggers (if they run application code, not just CI)
- `Procfile` worker / scheduler dynos

### Filename hints

Directories named `queues/`, `jobs/`, `workers/`, `tasks/`, `consumers/`, `processors/`, `schedulers/`. Files named `*_worker.{ts,py,rb,go}`, `*_job.{ts,py,rb}`, `*.consumer.ts`, `*.processor.ts`, `*_task.py`.

### Env vars

`REDIS_URL`, `KAFKA_BROKERS`, `KAFKA_BROKER_URL`, `AMQP_URL`, `RABBITMQ_URL`, `SQS_QUEUE_URL`, `BROKER_URL`, `CELERY_BROKER_URL`, `PUBSUB_TOPIC`.

If at least two signals match (across any of the four categories above), treat async messaging as confirmed and spawn `queues-investigator`. Note: Redis on its own is not enough — it's used as both a queue broker and a plain cache; look for queue-library imports or worker entry points alongside the Redis URL.

## External services

Anything the repo calls out to that isn't its own DB:

- **HTTP clients hitting non-localhost URLs** — `axios.get`, `fetch`, `requests.get`, `httpx.AsyncClient`, `http.Client.Get`
- **SDK imports**: `stripe`, `twilio`, `@aws-sdk/*`, `@google-cloud/*`, `redis`/`ioredis`, `kafkajs`, `@elastic/elasticsearch`, `pg`/`mysql2` (note: those are DB clients, list them under DB unless used for an *external* DB), `algoliasearch`, `pinecone`, `@sendgrid/mail`
- **Env vars**: `*_API_KEY`, `*_BASE_URL`, `*_URL`, `*_HOST`, `*_TOKEN`. Names usually identify the service (`STRIPE_*`, `TWILIO_*`)
- **Config files**: `infisical/*`, `.env.example`, `config/*.yaml` listing service hosts

For each external service, note the env var(s) that point at it — useful for the External services list.

## Notable-workflow signals

Things worth flagging as "notable workflows / unique logic" usually have these naming hints — search for them across the codebase:

- **Ranking / selection / sorting**: `rank*`, `score*`, `sort*` (when not a stdlib call), `select*`, `match*`, `prioritize*`, `top_k`, `recommend*`
- **Transformation / reshaping**: `transform*`, `reshape*`, `parse*Response`, `extract*`, `normalize*`, `enrich*`
- **Reliability mechanics**: `idempot*`, `retry*`, `dedup*`, `lock*`, `circuit*`, `backoff*`
- **Auth / policy**: `auth*`, `permission*`, `policy*`, `acl*`, `authorize*`, `can_*`
- **Multi-step orchestration**: `pipeline*`, `orchestrat*`, `workflow*`, `saga*`, `step*`, `stage*`
- **Async / queue handlers**: `*Job`, `*Worker`, `*Consumer`, `*Processor`, `enqueue*`, `publish*`, `subscribe*`, `processBatch*`, `handle*Event`, `on*Message`

Once you find a candidate, **read the file**. The point is *unique* logic, not anything matching a name pattern. A function named `sortUsers` that just calls `.sort()` is not notable. A function that ranks search results by a custom blend of recency, relevance, and personalization is notable.

When reading, look for **comments** — they often say *why* the code is the way it is. Quote a comment if it captures the rationale concisely.

## Module-complexity heuristics

Used in Phase 1 to decide which top-level modules deserve a `domain-investigator` instance.

A module is likely complex/core if:

- It has many files (>10) or many subdirectories
- It contains naming hints: `*service*`, `*orchestrator*`, `*pipeline*`, `*workflow*`, `*engine*`, `*manager*`, `*processor*`
- It is heavily imported by other modules (high fan-in)
- The README mentions it by name as a core concept
- It has its own subdirectory under `src/` rather than living as a single file

Skip modules that look like:

- Thin CRUD layers (`routes/users.ts` with one handler per endpoint)
- Generated clients or schemas
- Utility folders (`utils/`, `helpers/`)
- Type definition folders (`types/`)
- Test directories (`__tests__/`, `tests/`, `test/`)
- Vendor / generated code (`vendor/`, `generated/`)