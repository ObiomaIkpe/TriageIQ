# TriageIQ

LangGraph-powered support ticket triage: it classifies a ticket, routes it to a team, drafts a reply grounded in a knowledge base, reviews its own draft, and flags anything a human should check before it goes out.

Built with FastAPI, LangGraph, Claude, Voyage AI embeddings, Postgres with pgvector, SQLAlchemy 2.0 and Alembic.

## What it does

`POST /triage` takes a ticket (`subject`, `body`) and returns:

- a **category** (billing, technical, account, shipping, other) and **urgency** (low to critical), with a confidence score
- a **routing target**, such as `billing-team-urgent`
- a **suggested reply**, written only from knowledge base articles it retrieved
- the **KB sources** it used (topic, content, cosine distance)
- a **human-review flag** with a reason, so unsure or unsupported results do not go out unchecked
- a **`ticket_id`**: every result is saved, and can be read back from `/tickets`

## Architecture

### How a ticket flows

```mermaid
flowchart TD
    client([Client]) -->|POST /triage| api["FastAPI endpoint<br/>creates ticket_id"]
    api --> classify

    subgraph pipeline [LangGraph pipeline]
        classify["classify<br/>Claude, structured output"] --> route["route<br/>category to team, plain code"]
        route --> gate{"confidence at or above threshold?"}
        gate -- yes --> retrieve["retrieve_kb<br/>Voyage embedding + pgvector search"]
        retrieve --> draft["draft_reply<br/>Claude, grounded in the KB"]
        draft --> critique["critique<br/>rule checks, then Claude"]
        gate -- no --> flag["flag_low_confidence<br/>no KB or LLM calls"]
    end

    critique --> save[("tickets table")]
    flag --> save
    save --> response([TriageResult JSON])
```

| Node | Uses an LLM | Writes |
|---|---|---|
| `classify` | Claude (structured output) | `classification` |
| `route` | no | `routing_target` |
| `retrieve_kb` | no (Voyage embedding + SQL) | `kb_context`, `kb_failed` |
| `draft_reply_node` | Claude | `draft_reply` |
| `critique` | only when the rule checks pass | `needs_human_review`, `review_reason` |
| `flag_low_confidence` | no | `needs_human_review`, `review_reason` |

Each node returns only the state keys it writes, so the graph stays safe to branch and parallelise.

### Components

```mermaid
flowchart LR
    app["FastAPI app<br/>(uvicorn)"] --> anthropic["Anthropic API<br/>classify, draft, critique"]
    app --> voyage["Voyage AI<br/>embeddings"]
    app --> pg[("Postgres + pgvector<br/>kb_documents, tickets")]
    app --> alembic["Alembic migrations<br/>run at startup"]
    alembic --> pg
```

## API

| Endpoint | Purpose |
|---|---|
| `POST /triage` | Triage a ticket and save the result |
| `GET /tickets?status=&limit=` | List tickets, newest first. `status` is `triaged` or `pending_review`; `limit` is 1 to 200 (default 50) |
| `GET /tickets/{ticket_id}` | One ticket, with the original subject and body. 404 if missing, 422 for a malformed id |
| `GET /health` | Liveness: the process is up |
| `GET /ready` | Readiness: Postgres answers and the KB table exists |
| `GET /docs` | Interactive OpenAPI docs |

Example (the values are illustrative):

```bash
curl -X POST localhost:8000/triage \
  -H "Content-Type: application/json" \
  -d '{"subject": "Account locked", "body": "I tried my password too many times and now I cannot log in."}'
```

```json
{
  "ticket_id": "3f6c1d8e-9a4b-4c21-8e0a-5b7d2f1a9c44",
  "category": "account",
  "urgency": "high",
  "confidence": 0.95,
  "routing_target": "account-management-urgent",
  "suggested_reply": "Your account locks after 5 failed attempts and unlocks automatically after 1 hour...",
  "kb_sources": [
    {
      "topic": "account lockout",
      "content": "Accounts lock after 5 failed login attempts within 15 minutes. Lockout clears automatically after 1 hour.",
      "distance": 0.33
    }
  ],
  "needs_human_review": false,
  "review_reason": null
}
```

Errors: a temporary Claude outage returns `503` with `Retry-After`; so does an unreachable database. Other failures, such as a bad API key, stay `500` on purpose, because they are bugs, not outages.

## Design decisions

- **Routing is plain code, not an LLM.** The model decides what a ticket *is*; a lookup table decides where it goes. That keeps routing predictable, free, and easy to change.
- **The critic sees the KB.** Reviewing a reply for unsupported claims needs the articles it should be supported by. Rule checks (KB failed, no KB match) flag a ticket without spending an LLM call, so only grounded drafts reach the LLM critic.
- **Low-confidence tickets skip the expensive steps.** A conditional edge sends them straight to human review, with no retrieval, drafting or critique. The threshold is a setting (`LOW_CONFIDENCE_THRESHOLD`, default 0.6).
- **Retrieval has a similarity cutoff, chosen from measurements.** Search returns up to 3 articles within a cosine distance of 0.5, and may return none. On the sample articles, real matches landed around 0.33 to 0.35 and everything else at 0.56 or more. When nothing is close enough, the drafter is told to say a specialist will follow up instead of guessing. The value is provisional; see the limitations.
- **Failures degrade instead of crashing.** If the KB lookup fails, the ticket continues without context and is flagged. Claude calls have a timeout and retries; Voyage calls are rate limited, retried with backoff and cached in memory.
- **The ticket id exists before the graph runs.** It is generated up front so a later human-in-the-loop step can pause and resume a run under that id. A result is saved only after a successful run.
- **Structured output, not text parsing.** The classifier and critic use `with_structured_output` with Pydantic models.
- **The schema belongs to Alembic.** The app applies migrations at startup. Data access uses SQLAlchemy 2.0 with pgvector's `Vector` type.
- **Tested against a real Postgres.** Most tests need no database or API keys. The integration tests run the migrations and both stores against a real pgvector database, in a separate database that is wiped for each test.

## Quickstart (Docker)

You need Docker and API keys for Anthropic and Voyage AI.

```bash
cp .env.example .env          # then fill in ANTHROPIC_API_KEY and VOYAGE_API_KEY
docker compose up --build -d
docker compose exec app python -m app.kb.ingest   # seeds 5 sample FAQ articles
```

On the Voyage free tier (3 requests per minute) seeding takes about a minute; the built-in rate limiter waits as needed. Then send the `curl` request above, or open http://localhost:8000/docs.

The app container applies the database migrations at startup. Postgres is also published on host port **5433**.

## Configuration

Settings come from the environment or `.env` (`app/config.py`).

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Claude calls |
| `VOYAGE_API_KEY` | none | Embeddings |
| `DATABASE_URL` | `postgresql://triageiq:triageiq@localhost:5432/triageiq` | Postgres. In Docker, compose overrides it to point at the `db` service |
| `MODEL_ID` | `claude-sonnet-4-6` | Model for all three LLM steps |
| `LLM_TIMEOUT_SECONDS` / `LLM_MAX_RETRIES` | `30` / `2` | Claude call limits |
| `LOW_CONFIDENCE_THRESHOLD` | `0.6` | Below this, a ticket goes straight to human review |
| `VOYAGE_RPM` | `3` | Voyage requests per minute; raise it on a paid account |
| `LANGCHAIN_TRACING_V2`, `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT` | off | Optional LangSmith tracing |
| `APP_ENV`, `LOG_LEVEL` | `development`, `INFO` | Environment and logging |

Running outside Docker: install `requirements.txt`, set `DATABASE_URL` to a Postgres with pgvector (the compose database is on `localhost:5433`), run `alembic upgrade head`, then `uvicorn app.main:app`.

## Development

```bash
pip install -r requirements.txt
pytest                         # unit tests; no database or API keys needed
```

The tests in `tests/integration/` need a real Postgres and are skipped unless you opt in. The database name must end in `_test`; it is created if missing and wiped before each test:

```bash
docker compose up -d db
TEST_DATABASE_URL=postgresql://triageiq:triageiq@localhost:5433/triageiq_test pytest
```

Changing the schema: edit the models, run `alembic revision --autogenerate -m "describe the change"`, review the generated file, and commit it. `alembic check` reports drift between the models and the database.

## Project layout

```
app/
  main.py              FastAPI app, startup migrations, /health and /ready
  api/                 POST /triage, GET /tickets
  graph/               the LangGraph nodes and build.py (the wiring)
  kb/                  Voyage embeddings, rate limiter, KB search, ingest script
  tickets/             saving and reading tickets
  db.py, migrations.py engine and sessions; running Alembic from the app
  models.py            Pydantic models and the graph state
alembic/               migrations (the only place that creates tables)
tests/                 unit tests; tests/integration/ needs a real Postgres
```

## Status and limitations

This is a working prototype, not a finished product.

- **Not yet measured on labelled data.** Classification accuracy, how often replies are flagged, and reply quality have no benchmark. The 0.6 confidence threshold and the 0.5 distance cutoff are provisional, set from a handful of examples.
- **The confidence score is the model's own.** It is not calibrated, so treat it as a rough signal.
- **No human-review workflow yet.** Tickets flagged `pending_review` are stored and listable, but nothing approves, edits or rejects them.
- **No authentication or request limits.** The endpoints are open, and each ticket costs up to three Claude calls and one embedding call.
- **No specific defence against prompt injection.** Ticket text goes into the prompts. The human-review flag helps, but the critic is itself an LLM reading that text.
- **A failed save loses the response.** If the database goes down after the work is done, the client gets a 503 and the triage has to be paid for again on retry.
- **A small sample KB.** Only 5 FAQ articles are included, and there are no tools for managing articles beyond the ingest script.
- **Run one instance.** Migrations are not locked against concurrent starts.

## More

- [`NOTES.md`](NOTES.md): a walkthrough of how each part works, plus known gaps and what has been fixed.
- [`ROADMAP.md`](ROADMAP.md): the full list of planned work.
