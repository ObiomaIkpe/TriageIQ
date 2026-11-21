# TriageIQ

LangGraph-powered support ticket triage: it classifies a ticket, routes it to a team, drafts a reply grounded in a knowledge base, reviews its own draft, and flags anything a human should check before it goes out.

Built with FastAPI, LangGraph, Claude, Voyage AI embeddings, Postgres with pgvector, SQLAlchemy 2.0 and Alembic, behind a NestJS gateway (BullMQ on Redis) that does authentication, rate limiting, queueing, retries and idempotency. **Clients only ever talk to the gateway**; the Python service is not reachable from outside the compose network.

## What it does

The Python service's `POST /triage` takes a ticket (`subject`, `body`) and returns the result below. In the full system a client does not call it: it submits the ticket to the gateway's `POST /tickets` and polls for this result (see "Life of a ticket").

- a **category** (billing, technical, account, shipping, other) and **urgency** (low to critical), with a confidence score
- a **routing target**, such as `billing-team-urgent`
- a **suggested reply**, written only from knowledge base articles it retrieved
- the **KB sources** it used (topic, content, cosine distance)
- a **human-review flag** with a reason, so unsure or unsupported results do not go out unchecked
- a **`ticket_id`** and a short, human-friendly **`reference`** (such as `TKT-7K3M9Q`): every result is saved, and a reviewer can read it back (Python's `/tickets`, offered to reviewers through the gateway)

## Architecture

### How the triage pipeline works (Python)

```mermaid
flowchart TD
    client([Client]) -->|POST /triage| api["FastAPI endpoint<br/>creates ticket_id"]
    api --> classify

    subgraph pipeline [LangGraph pipeline]
        classify["classify<br/>Claude, structured output"] --> route["route<br/>category to team, plain code"]
        route --> gate{"confident, and not category other?"}
        gate -- yes --> retrieve["retrieve_kb<br/>Voyage embedding + pgvector search"]
        retrieve --> grade["grade_kb<br/>Claude keeps only articles that answer the ticket"]
        grade --> draft["draft_reply<br/>Claude, grounded in the KB"]
        draft --> critique["critique<br/>rule checks, then Claude"]
        gate -- no --> flag["flag_low_confidence<br/>no KB or LLM calls"]
    end

    critique --> review{{"human_review<br/>pauses if flagged"}}
    flag --> review
    review --> save[("tickets table")]
    save --> response([TriageResult JSON])
```

| Node | Uses an LLM | Writes |
|---|---|---|
| `classify` | Claude (structured output) | `classification` |
| `route` | no | `routing_target` |
| `retrieve_kb` | no (Voyage embedding + SQL) | `kb_context`, `kb_failed` |
| `grade_kb` | Claude, only when articles were retrieved | `kb_context` (filtered), `kb_grade` |
| `draft_reply_node` | Claude | `draft_reply`, `draft_truncated` |
| `critique` | only when the rule checks pass | `needs_human_review`, `review_reason` |
| `flag_low_confidence` | no | `needs_human_review`, `review_reason` |
| `human_review` | no | `review_decision`, `final_reply` (only after a reviewer decides) |

Each node returns only the state keys it writes, so the graph stays safe to branch and parallelise.

Why flagged: a ticket is sent to a human when the classifier is unsure ("Low classifier confidence."), the classifier calls it "other" ("Ticket could not be categorised."), the critic objects, or the knowledge base cannot ground the reply. The KB reasons are "No knowledge base match." (nothing retrieved), "KB article does not answer the ticket." (articles were retrieved but `grade_kb` kept none), "KB relevance check unavailable." (the grader call failed; the request still succeeds) and "Possible prompt injection in the ticket." (the grader suspects the ticket tries to instruct or redirect an automated system; this reason overrides every other one, and the ticket still gets its normal draft) and "Knowledge base unavailable." (retrieval failed). `kb_grade` is internal state and is not part of the API response.

Tickets classified as `other` skip retrieval and drafting and go straight to human review, exactly like low-confidence tickets, whatever their confidence. The reason is that the classifier can be confident a ticket is "other" (its definition includes tickets too vague to tell), so confidence alone is not a safe signal for vague tickets. If both apply, the reason is "Low classifier confidence." Their `routing_target` is unchanged (`general-queue`, or `general-queue-urgent`).

### The whole system

```mermaid
flowchart LR
    subgraph outside ["Outside the stack"]
        client(["Client<br/>submitter key"])
        reviewer(["Reviewer<br/>reviewer key"])
    end

    subgraph compose ["Docker compose network"]
        subgraph gw ["NestJS gateway: the only published service, 127.0.0.1:3000"]
            guards["Auth, roles, rate limit,<br/>security headers"]
            intake["POST /tickets<br/>intake and Idempotency-Key"]
            passthrough["Reviewer routes<br/>read tickets, review, dead letters"]
            worker["Triage worker<br/>retries with backoff"]
        end
        redis[("Redis<br/>job queue, idempotency keys,<br/>rate counters, dead letters")]
        app["Python app: FastAPI + LangGraph<br/>port NOT published"]
        pg[("Postgres + pgvector<br/>Python DB: tickets, checkpoints, KB<br/>gateway DB: reviewer accounts")]
    end

    claude["Anthropic Claude<br/>classify, grade, draft, critique"]
    voyage["Voyage AI<br/>embeddings"]

    client -->|"Bearer key"| guards
    reviewer -->|"Bearer key"| guards
    guards --> intake
    guards --> passthrough
    intake -->|"job"| redis
    redis -->|"job"| worker
    worker -->|"POST /triage, ticket_id = job id"| app
    passthrough -->|"read tickets, review (gateway's own review key)"| app
    passthrough -.->|"dead letters"| redis
    app --> pg
    worker -.->|"reviewer accounts"| pg
    app --> claude
    app --> voyage
```

The gateway is the only way in. The compose file publishes just the gateway (on `127.0.0.1:3000`); the Python app has no published port and is reached only by the gateway, at `app:8000` on the compose network. Postgres (5433) and Redis (6380) are published on `127.0.0.1` for local tools only. Reviewers never hold Python's review key: the gateway keeps it and adds it to the calls it forwards.

| Part | Does | Lives in |
|---|---|---|
| Gateway (`gateway/`, NestJS 12, Node 24) | API keys and roles, per-client rate limit, job ownership, security headers; intake with idempotency keys; the triage worker; dead-letter list and retry; reviewer routes that forward to Python | compose service `gateway` |
| Redis | BullMQ queue (jobs, failed set), idempotency keys (`idem:<client>:<key>`, 24 h), rate counters (`rl:<client>`) | compose service `redis` |
| Python app (`app/`, FastAPI + LangGraph) | the triage graph, ticket storage, human review, Alembic migrations at startup | compose service `app` |
| Postgres + pgvector | one server, two databases with separate roles: Python's (`tickets`, `kb_documents`, the LangGraph checkpoint tables) and the gateway's own `gateway` database (reviewer accounts, `users`). The gateway also gets `gateway-migrate`, a one-shot service that applies its migrations before it starts | compose services `db` and `gateway-migrate` |
| Anthropic, Voyage AI | the language model and the embeddings | external APIs, called only by the Python app |

### Life of a ticket

1. **Submit.** A client sends `POST /tickets` to the gateway with `Authorization: Bearer <key>` and, if it may retry, an `Idempotency-Key`. The gateway checks the key (401), the client's rate limit (429), the role, and the body (400/413/415).
2. **Idempotency (client to gateway).** With an `Idempotency-Key` the gateway claims `idem:<client>:<key>` in Redis (`SET NX EX 24 h`). A repeat of the same key and ticket gets the same job id (`Idempotent-Replayed: true`) and no second job; the same key with a different ticket is a 422.
3. **Queue.** The gateway stores a BullMQ job in Redis (its id is a new UUID, and the submitting client's name is stored with it) and answers `202` with a `status_url`. The client polls `GET /jobs/:id`; a submitter sees only its own jobs.
4. **Worker.** The gateway's worker takes the job and sends the ticket to Python's `POST /triage`, with the job id as `ticket_id`, waiting up to `TRIAGE_TIMEOUT_MS`.
5. **Idempotency (gateway to Python).** Python takes a Postgres advisory lock on the `ticket_id`. If a ticket row exists it answers from it; if a finished or paused run exists it rebuilds the answer from the saved state; otherwise it runs the graph. Either way a ticket is triaged and saved at most once, however many times the job is sent.
6. **Triage.** The LangGraph pipeline classifies the ticket, routes it, and (if it is confident and not category `other`) retrieves KB articles with Voyage embeddings, has Claude grade them, drafts a reply and critiques it. Anything unsure, unsupported or vague is flagged. Every run ends at `human_review`.
7. **Retries.** If Python answers `503`/`429`/`502`/`504`, or cannot be reached, the worker retries with backoff (up to 8 attempts, about 15 minutes in all; a `Retry-After` is honoured). Other `4xx` and `500` fail the job at once, because a retry would repeat paid model calls for nothing.
8. **Done.** The Python result becomes the job's result, and the client's next poll shows `done` with the `ticket_id`, `reference`, category, reply and review flag.
9. **Dead letters.** A job that fails for good (attempts used up, or a ticket Python rejects) stays in Redis's failed set for 30 days. A reviewer lists them with `GET /dead-letters` and re-queues one with `POST /dead-letters/:id/retry`: same job id, a full set of attempts, and step 5 makes it safe even if Python had already saved the ticket.
10. **Human review.** A ticket from the public form travels the same way, owned by the built-in client `public-form`, with the customer's name and email stored for the reviewer but never shown to the model. A flagged ticket is saved as `pending_review` with its graph paused. A reviewer finds it with `GET /tickets?status=pending_review` (or by id or `TKT-` reference) and decides with `POST /tickets/:id/review`. The gateway validates the decision, forwards it to Python with the review key, and Python resumes the graph and marks the ticket `approved`, `edited` or `rejected`. The gateway also tells Python **who is deciding**, taken from the authenticated caller (a logged-in reviewer as `user:<uuid>` with their display name, or an API client as `client:<name>`), never from the request body; Python stores it with the decision and every later read of the ticket shows `reviewed_by`. A second review of the same ticket is a `409` and keeps the first reviewer.

## API

| Endpoint | Purpose |
|---|---|
| `POST /triage` | Triage a ticket and save the result. An optional `ticket_id` (a UUID) makes it safe to send the same ticket again: it is triaged and saved at most once (see below) |
| `GET /tickets?status=&limit=` | List tickets, newest first. `status` is `triaged`, `pending_review`, `approved`, `edited` or `rejected`; `limit` is 1 to 200 (default 50) |
| `GET /tickets/{ticket_id}` | One ticket, with the original subject and body, and the review fields (`final_reply`, `review_note`, `reviewed_at`, all null until a reviewer decides). 404 if missing, 422 for a malformed id |
| `GET /tickets/reference/{reference}` | The same record, found by its short reference (such as `TKT-7K3M9Q`). 404 if unknown |
| `POST /tickets/{ticket_id}/review` | Approve, edit or reject a ticket that is waiting for review. Needs the `X-API-Key` header (see below) |
| `GET /health` | Liveness: the process is up |
| `GET /ready` | Readiness: Postgres answers, the KB table exists and the triage graph is built |
| `GET /docs` | Interactive OpenAPI docs |

> **The Python API is not published in the normal stack.** The examples below call it on `localhost:8000`, which works only with the debug override (`docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d`, which publishes the app on `127.0.0.1:8000` and nothing else). Otherwise submit tickets through the gateway (`POST /tickets`) and read and review them through the gateway's reviewer routes (see "Reviewer routes" under Gateway (M3)).

Example (the values are illustrative):

```bash
curl -X POST localhost:8000/triage \
  -H "Content-Type: application/json" \
  -d '{"subject": "Account locked", "body": "I tried my password too many times and now I cannot log in."}'
```

```json
{
  "ticket_id": "3f6c1d8e-9a4b-4c21-8e0a-5b7d2f1a9c44",
  "reference": "TKT-7K3M9Q",
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

### Sending the same ticket twice: `ticket_id`

`TicketIn` accepts an optional `ticket_id` (a UUID; anything else is a `422`). Without it nothing changes. With it, that id becomes the ticket's id and the run's thread id, and the same request can be repeated safely. The gateway worker always sends it (its job id), so a retry of a job never creates a second ticket.

1. The request takes a Postgres **advisory lock** on the id, so two requests with the same id never run at the same time. The second waits (up to 150 seconds, then a `503` with `Retry-After`) and then finds the first one's row.
2. If a **ticket row with that id exists**, it is returned in the normal response shape (the same `TriageResult`). The graph does not run, so no Claude or Voyage call is made. The response is the original triage, even if a reviewer has decided since.
3. If there is **no row, but the checkpointer holds a run that finished or is paused at `human_review`** (the app stopped, or the save failed, after the graph finished), the answer is rebuilt from that saved state and the row is saved. No model calls. A flagged ticket is saved as `pending_review` and can still be reviewed.
4. If the saved run **stopped halfway**, its checkpoints are cleared (`delete_thread`) and the ticket is triaged again from the start.
5. If a save hits the primary key anyway (a race the lock should prevent), the existing row is returned, never a `500`.

The text of a repeated request is not compared: the row (or the saved run) from the first request wins. The gateway only ever repeats the same ticket under the same id.

### Reviewing a flagged ticket

This is the Python endpoint itself (debug override only). Reviewers normally use `POST /tickets/:id/review` on the gateway, which sends this same request for them with the key attached.

```bash
curl -X POST localhost:8000/tickets/<ticket_id>/review \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your REVIEW_API_KEY>" \
  -d '{"action": "edit", "edited_reply": "Your account unlocks after 1 hour.", "note": "shortened", "reviewer": {"id": "client:ops", "name": "Ops team"}}'
```

- `action` is `approve`, `edit` (needs a non-empty `edited_reply`) or `reject`; `note` is optional. **`reviewer` is required:** `{"id": ..., "name": ...}` where `id` is `user:<uuid>` (a logged-in reviewer) or `client:<name>` (an API client, lower case letters, digits and `-`, up to 40 characters) and `name` is 1 to 100 characters after trimming, any Unicode. A missing or malformed `reviewer` is `422`. The response is the updated ticket (`status` is `approved`, `edited` or `rejected`, with `final_reply`, `review_note`, `reviewed_at` and `reviewed_by` filled in).
- **Who decided.** The decision is stored together with `reviewed_by_id` and `reviewed_by_name` in the same statement, so a review is never saved without its author, and the name is a snapshot (renaming a reviewer later does not change old reviews). Every ticket read (`GET /tickets`, `/tickets/{id}`, `/tickets/reference/{reference}`) includes `reviewed_by: {"id", "name"}`, or `null` for a ticket not reviewed yet and for tickets reviewed before this was recorded. **Python trusts `reviewer` only because this endpoint already requires the service review key, which only the gateway holds:** the gateway fills `reviewer` in from the caller it authenticated and never from the client's own body. Anyone who holds the key can name any reviewer, so the key must stay on the server.
- The key is the `REVIEW_API_KEY` setting, sent as `X-API-Key`. **If the setting is empty the endpoint is disabled** and answers `503`; a missing or wrong key is `401`.
- `404` unknown ticket. `409` the ticket is not waiting for a review (already reviewed, or its paused run is gone). `422` an invalid body, or `approve` on a ticket that has no draft reply (a low-confidence ticket skips drafting), which can be edited or rejected instead.
- The ticket's row is locked while it is reviewed, so two reviewers acting at the same moment get one `200` and one `409`.

Errors: a temporary Claude outage returns `503` with `Retry-After`; so does an unreachable database. Other failures, such as a bad API key, stay `500` on purpose, because they are bugs, not outages.

## Design decisions

- **Routing is plain code, not an LLM.** The model decides what a ticket *is*; a lookup table decides where it goes. That keeps routing predictable, free, and easy to change.
- **The critic sees the KB.** Reviewing a reply for unsupported claims needs the articles it should be supported by. Rule checks (KB failed, no KB match, draft cut off at the token limit) flag a ticket without spending an LLM call, so only grounded, complete drafts reach the LLM critic.
- **Low-confidence tickets skip the expensive steps.** A conditional edge sends them straight to human review, with no retrieval, drafting or critique. The threshold is a setting (`LOW_CONFIDENCE_THRESHOLD`, default 0.6).
- **Retrieval has a loose cutoff, and a grader decides relevance.** Search returns up to 3 articles within a cosine distance of 0.65 (loosened from 0.5), and may return none. The cutoff only removes clearly unrelated articles: the retrieval reports showed the right article ranked first every time, but no single distance separated articles that answer a ticket from articles that merely share its topic. So the `grade_kb` step asks Claude which retrieved articles directly answer the ticket and keeps only those. When nothing is left, the drafter is told to say a specialist will follow up instead of guessing, and the ticket is flagged. This adds one Claude call per ticket that retrieves at least one article. The values are provisional; see the limitations.
- **Failures degrade instead of crashing.** If the KB lookup fails, the ticket continues without context and is flagged. Claude calls have a timeout and retries; Voyage calls are rate limited, retried with backoff and cached in memory.
- **The ticket id exists before the graph runs, and is the run's `thread_id`.** The graph is compiled at startup with a Postgres checkpointer, so every run's state is saved under the ticket's id. That lets a later human-in-the-loop step pause and resume a run by ticket id. A result is saved only after a successful run. If startup cannot reach the database, the app still boots and `/triage` and `/ready` answer `503` until it can.
- **A flagged ticket pauses the graph for a human.** `human_review` calls LangGraph's `interrupt()` only when `needs_human_review` is true; unflagged tickets pass straight through. `POST /triage` still answers normally: a paused run counts as a success and is saved as `pending_review`, and the pause marker never reaches the client. The paused state lives in the Postgres checkpointer under the ticket id, so it survives a restart. `app/graph/review.py` has `is_paused()` and `resume_review()` (approve, edit or reject), which `POST /tickets/{id}/review` calls (reviewers reach it through the gateway). When a run resumes, LangGraph runs the `human_review` node again from its start, so nothing before the `interrupt()` call may have side effects.
- **Structured output, not text parsing.** The classifier and critic use `with_structured_output` with Pydantic models.
- **The schema belongs to Alembic, with one exception.** The app applies migrations at startup. Data access uses SQLAlchemy 2.0 with pgvector's `Vector` type. The LangGraph checkpoint tables are the exception: the checkpointer library creates and upgrades them itself.
- **Tested against a real Postgres.** Most tests need no database or API keys. The integration tests run the migrations and both stores against a real pgvector database, in a separate database that is wiped for each test.

## Run the whole system

You need Docker (the native engine on Linux is recommended, see Troubleshooting), API keys for Anthropic and Voyage AI, and Node 24 or Docker for the key tool. The stack reads **two env files**, so secrets stay apart (the root `.env` also feeds the database service one value):

| File | Read by | What goes in it |
|---|---|---|
| `.env` (root; copy `.env.example`) | the Python app (`env_file: .env`), and compose itself for the database service | `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, and `REVIEW_API_KEY` (uncomment it and give it a long random value: **empty disables review**). Compose overrides `DATABASE_URL`. **Also add `GATEWAY_DB_PASSWORD=<a long random password>`** (the password of the gateway's database role; compose will not start without it; it is not in `.env.example` because that file lists only the Python app's own settings) |
| `gateway/.env` (copy `gateway/.env.example`) | the gateway (`env_file: gateway/.env`) | `GATEWAY_CLIENTS` (the hashed client keys), `TRIAGE_REVIEW_API_KEY` (**the same value as `REVIEW_API_KEY`**), `GATEWAY_DATABASE_URL` (**the same password as `GATEWAY_DB_PASSWORD`**, URL-encoded), optionally `RATE_LIMIT_PER_MINUTE` |

Both files are git-ignored, and the root `.dockerignore` and `gateway/.dockerignore` keep them out of the images.

```bash
# 1. The two env files
cp .env.example .env                  # fill in ANTHROPIC_API_KEY, VOYAGE_API_KEY, REVIEW_API_KEY, and add GATEWAY_DB_PASSWORD=...
cp gateway/.env.example gateway/.env  # fill in TRIAGE_REVIEW_API_KEY (= REVIEW_API_KEY) and GATEWAY_DATABASE_URL (password = GATEWAY_DB_PASSWORD)

# 2. Client keys: one submitter, one reviewer (and a second submitter if you want the ownership check).
#    Each run prints the KEY once (store it) and a registry entry containing only its hash.
cd gateway
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:24 \
  npm run make-client-key -- alice submitter
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:24 \
  npm run make-client-key -- ops reviewer
cd ..
# Put the entries in gateway/.env as one line of JSON in single quotes:
#   GATEWAY_CLIENTS='[{"name":"alice","role":"submitter","key_sha256":"..."},{"name":"ops","role":"reviewer","key_sha256":"..."}]'

# 3. Start everything and load the knowledge base. On a NEW database volume the db container creates the
#    gateway role and database by itself; then `gateway-migrate` creates the tables, then the gateway starts.
#    On an EXISTING volume run scripts/create_gateway_db.sh once first (see "Reviewer accounts").
docker compose up --build -d
docker compose exec app python -m app.kb.ingest     # seeds 5 sample FAQ articles
```

On the Voyage free tier (3 requests per minute) seeding takes about a minute; the built-in rate limiter waits as needed.

**Smoke test.** `scripts/e2e_smoke.py` checks the whole system through the gateway in nine steps (health, a refused request, submit and idempotent replay, the job finishing, ownership, reviewer reads, a flagged ticket reviewed once and then refused, and 403s for a submitter), plus an **optional tenth step** that logs a reviewer in with a session cookie, uses it and logs out (it needs the reviewer's email and password, and `E2E_ORIGIN` if your `ALLOWED_ORIGINS` is not `http://localhost:5173`). plus an **optional eleventh step** for the public form (`E2E_PUBLIC_FORM=1`: it submits through `POST /public/tickets` with Cloudflare's dummy Turnstile token and an Origin header, then reads the ticket back as the reviewer and checks `customer_email`; it needs the gateway running with `PUBLIC_FORM_ENABLED=true` and the dummy secret, and it costs one more ticket's model calls). It uses only the standard library. **It creates real tickets and spends model calls**, so run it deliberately. Its test tickets have a subject starting `[e2e <run id>]` and `customer_id` `e2e-smoke`. Enter the keys without echoing them:

```bash
read -rsp "submitter key: " E2E_SUBMITTER_KEY; echo
read -rsp "reviewer key: "  E2E_REVIEWER_KEY;  echo
read -rsp "other submitter key (optional, Enter to skip): " E2E_OTHER_SUBMITTER_KEY; echo
read -rp  "reviewer email for the login step (optional, Enter to skip): " E2E_REVIEWER_EMAIL
read -rsp "reviewer password (optional): " E2E_REVIEWER_PASSWORD; echo
export E2E_SUBMITTER_KEY E2E_REVIEWER_KEY E2E_OTHER_SUBMITTER_KEY E2E_REVIEWER_EMAIL E2E_REVIEWER_PASSWORD
python3 scripts/e2e_smoke.py        # E2E_BASE_URL defaults to http://localhost:3000
```

It prints PASS, FAIL or SKIP per step and a summary, and exits 0 when nothing failed, 1 when something did, 2 when a required key is missing. A failed step makes the steps that depend on it SKIP. On the Voyage free tier it can take a few minutes (use `--timeout` to wait longer for a job).

**Debug override.** The Python app has no published port. To call it directly (`curl localhost:8000/...`, `http://localhost:8000/docs`), start the stack with the override, which publishes it on `127.0.0.1:8000` only:

```bash
docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d
```

The app container applies the database migrations at startup. Postgres is published on host port **5433** and Redis on **6380**, both bound to `127.0.0.1`.

## Configuration

Settings come from the environment or `.env` (`app/config.py`).

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Claude calls |
| `VOYAGE_API_KEY` | none | Embeddings |
| `DATABASE_URL` | `postgresql://triageiq:triageiq@localhost:5432/triageiq` | Postgres. In Docker, compose overrides it to point at the `db` service |
| `MODEL_ID` | `claude-sonnet-4-6` | Model for all three LLM steps |
| `LLM_TIMEOUT_SECONDS` / `LLM_MAX_RETRIES` | `30` / `2` | Claude call limits |
| `LLM_MAX_TOKENS` | `700` | Longest answer each Claude step may produce, in tokens (about 500 words). A longer answer is cut off. Must be greater than 0 |
| `LOW_CONFIDENCE_THRESHOLD` | `0.6` | Below this, a ticket goes straight to human review |
| `VOYAGE_RPM` | `3` | Voyage requests per minute; raise it on a paid account |
| `REVIEW_API_KEY` | empty | Shared secret for `POST /tickets/{id}/review`, sent as the `X-API-Key` header. **Empty disables the endpoint** (it answers 503) |
| `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` | off | Optional LangSmith tracing. The older `LANGCHAIN_*` names still work, but use only one set: if both are present and disagree, tracing is on when either says true |
| `APP_ENV`, `LOG_LEVEL` | `development`, `INFO` | Environment and logging |

Running outside Docker: install `requirements.txt`, set `DATABASE_URL` to a Postgres with pgvector (the compose database is on `localhost:5433`), run `alembic upgrade head`, then `uvicorn app.main:app`.

## Development

```bash
pip install -r requirements.txt
pytest                         # unit tests; no database or API keys needed (includes the smoke-test script, run against a fake gateway)
```

The gateway's own tests run inside `gateway/` (`npm test`, `npm run test:e2e`, `npm run lint`; see Gateway (M3)). The end-to-end smoke test against a running stack is `scripts/e2e_smoke.py` (see "Run the whole system"); it is not part of `pytest` because it spends model calls.

The tests in `tests/integration/` need a real Postgres and are skipped unless you opt in. The database name must end in `_test`; it is created if missing and wiped before each test:

```bash
docker compose up -d db
TEST_DATABASE_URL=postgresql://triageiq:triageiq@localhost:5433/triageiq_test pytest
```

Changing the schema: edit the models, run `alembic revision --autogenerate -m "describe the change"`, review the generated file, and commit it. `alembic check` reports drift between the models and the database.

## Evals

`evals/` holds a labelled set of 20 tickets (`evals/dataset/tickets_v1.jsonl`) and a script that runs each one through the real graph and scores the result. Scoring is deterministic string and value comparison; there is no LLM judge.

What it measures, per ticket:

- **category** and **urgency** equal the label (urgency is skipped when the label has none).
- **flag**: `needs_human_review` equals `expected_flag`. Tickets that should have been flagged but were not are listed first as MISSED FLAGS, and the reverse as EXTRA FLAGS.
- **kb_topic**: the topic of the closest retrieved article equals `expected_kb_topic` (no article equals `null`).
- **must_include / must_not_include**: phrases that must, or must not, appear in the draft reply (case-insensitive). Skipped when there is no draft.

Run it:

```bash
venv/bin/python -m evals.run_eval                    # all 20 tickets
venv/bin/python -m evals.run_eval --only T01,T05     # a subset
```

Options: `--dataset PATH`, `--only IDS`, `--out DIR` (default `evals/results`). It writes `<timestamp>.json` (everything, per ticket) and `<timestamp>.md` (the scorecard, also printed). The `.json` files are git-ignored; the `.md` scorecards can be committed.

**This makes real Claude and Voyage calls and costs money.** It needs `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`, and it reads the knowledge base from the database in `DATABASE_URL` (so that database must be up and ingested). It saves no tickets and uses an in-memory checkpointer. Each ticket costs up to 3 Claude calls (classify, draft, critique) and 1 Voyage embedding call; tickets the classifier is unsure about skip the last two Claude calls and the embedding. With the default `VOYAGE_RPM=3` the embedding calls are rate limited, so a full run takes several minutes.

### Retrieval distance report

```bash
venv/bin/python -m evals.retrieval_report            # optional: --only T01,T05
```

Shows, for every ticket, the cosine distance to **every** KB article with no cutoff applied, and whether a single cutoff value could accept all correct matches and reject all tickets that should match nothing. It is a measurement for tuning `MAX_DISTANCE` (currently 0.65); it changes nothing. It makes one Voyage embedding call per ticket (20 for the full set, no Claude calls) and only reads the database. At `VOYAGE_RPM=3` expect about 6 minutes. Output goes to `evals/results/retrieval-<timestamp>.json` and `.md`.

On 2026-10-21 the 5 KB articles were rewritten as realistic help articles (120 to 200 words each). Their policy sentences are unchanged and sit inside the new text word for word, and they were written without reading the eval set. Re-run the ingest to load them (see Run the whole system).

Read the numbers with care: the knowledge base is only 5 articles, so retrieval is easy, and 20 tickets is a small sample. One run is one sample of a non-deterministic model.

## Evals: results

A 20-ticket labelled set (AI-drafted, every label human-checked) is run through the real graph and scored deterministically. Run: `venv/bin/python -m evals.run_eval --dataset evals/dataset/tickets_v3.jsonl`.

| Check | Baseline (v1, 20 Oct) | Now (v3, 21 Oct) |
|---|---|---|
| Flags (should a human see it?) | 17/20, 3 unnecessary | 20/20 |
| Right KB article retrieved | 16/20 | 20/20 |
| Category | 18/20 | 20/20 |
| Key facts in reply | 4/9 | 10/10 |
| No invented advice | 15/17 | 16/17 (the miss is a scorer limit) |
| Urgency | 13/17 | 14/17 |
| Bad drafts over 3 repeated runs | 3 | 0 |

Labels changed between v1 and v3 (a KB policy decision for one ticket, a written urgency rule, scorer-proof phrases); each change is documented. The KB is five short articles, so real-world scores would be lower.

What changed, in order: a KB relevance grader after retrieval (distance thresholds could not separate answers from non-answers), prompt-injection flagging in the grader, two KB policy gaps fixed, three grounding rules for the drafter, product definitions for the classifier, and a code rule sending "other" tickets to a human.

Known limits: phrase checks cannot tell a reply that refuses a request from one that agrees to it, or recognise paraphrase; three urgency labels remain judgment calls; injection is only checked on tickets that reach the grader.

## Gateway (M3)

`gateway/` is a NestJS service in front of the Python app. It takes a ticket instantly, queues the slow AI work, retries and dead-letters failures, keeps a ticket from being triaged or saved twice, authenticates and rate-limits every client, and is the only way in. It was built in steps (M3.1 to M3.6), each described below: foundation and health, ticket intake, the triage worker and its retries, dead letters, idempotency, API keys with roles and per-client limits, reviewer routes and the closed Python port, and the end-to-end smoke test.

Redis holds the queue (compose service `redis`, appendonly persistence on, published on host port **6380**, bound to localhost).

Run it with the rest of the stack (see "Run the whole system"); the gateway is published on port **3000**, bound to `127.0.0.1`. The Python app's port is not published at all (only the gateway reaches it, at `app:8000`). To run the gateway by itself you need Node 24, a Redis, and a Python service it can reach (publish one with the debug override):

```bash
cd gateway
cp .env.example .env     # set REDIS_URL=redis://localhost:6380 for the compose Redis, put the GATEWAY_CLIENTS entries
                         # and TRIAGE_REVIEW_API_KEY in it; the example sets TRIAGE_SERVICE_URL=http://localhost:8000
npm install
npm run start:dev
```

**Settings.** `REDIS_URL`, `TRIAGE_SERVICE_URL`, `PORT` (compose sets these three inline), `GATEWAY_CLIENTS`, `TRIAGE_REVIEW_API_KEY` and `GATEWAY_DATABASE_URL` are required; the others have defaults. The gateway refuses to start if one is missing or invalid, and names each bad setting without printing its value. This table is the complete list:

| Variable | Default | Where it is set in Docker | Purpose |
|---|---|---|---|
| `PORT` | none (compose: `3000`) | `docker-compose.yml` | Port the gateway listens on (1 to 65535) |
| `REDIS_URL` | none (compose: `redis://redis:6379`) | `docker-compose.yml` | Redis connection (`redis://` or `rediss://`) |
| `TRIAGE_SERVICE_URL` | none (compose: `http://app:8000`) | `docker-compose.yml` | Base URL of the Python service (`http://` or `https://`). Running the gateway outside compose, use `http://localhost:8000` with the debug override |
| `WORKER_CONCURRENCY` | `2` | `docker-compose.yml` | How many tickets the worker sends to the Python service at once (1 to 10). Each ticket costs several Claude calls and a Voyage call, so this also protects the API rate limits |
| `TRIAGE_TIMEOUT_MS` | `120000` | `docker-compose.yml` | How long the worker waits for one answer from the Python service (1000 to 600000). A triage run makes several LLM calls, so this is generous. Keep `stop_grace_period` in compose longer than this |
| `RATE_LIMIT_PER_MINUTE` | `60` | `gateway/.env` | Requests each API client may make per minute (1 to 10000) |
| `GATEWAY_CLIENTS` | none (required) | `gateway/.env` | JSON array of `{name, role, key_sha256}`: the API clients (see "API keys, roles and rate limits") |
| `GATEWAY_DATABASE_URL` | none (required) | `gateway/.env` | The gateway's own database (reviewer accounts): `postgresql://gateway:<password>@db:5432/gateway`. Compose's host is `db:5432`; outside compose use `localhost:5433`. The password is `GATEWAY_DB_PASSWORD` from the root `.env`. Never logged; a bad value is reported by setting name only |
| `SESSION_IDLE_MINUTES` | `60` | `gateway/.env` | A reviewer session ends after this many minutes without use (1 to 1440) |
| `SESSION_ABSOLUTE_HOURS` | `8` | `gateway/.env` | A session ends this many hours after login, however busy it is (1 to 168). Also the cookie's `Max-Age` |
| `COOKIE_SECURE` | `true` | `gateway/.env` | Whether the session cookie has the `Secure` attribute. **Leave it `true`**; set `false` only for plain-`http` local development, because browsers refuse to store a `Secure` cookie from an `http://` page (M6 adds HTTPS, where it must be `true`). Anything but `true` or `false` is refused, so a typo cannot switch it off |
| `ALLOWED_ORIGINS` | empty | `gateway/.env` | Comma-separated browser origins (such as `http://localhost:5173`, no path) allowed to log in and to make cookie-authenticated writes. **Empty means none**, so login is refused until you set it. No CORS is added: the UI is served from the same origin as the gateway (M4.3) |
| `LOGIN_MAX_FAILURES_PER_IP` | `20` | `gateway/.env` | Failed logins one IP address may make per window before it is refused (1 to 100000) |
| `LOGIN_MAX_FAILURES_PER_EMAIL` | `5` | `gateway/.env` | Failed logins per email per window (1 to 1000) |
| `LOGIN_WINDOW_MINUTES` | `15` | `gateway/.env` | The window both failure limits count in (1 to 1440) |
| `TRUST_PROXY` | `false` | `gateway/.env` | Take the client IP from `X-Forwarded-For` (Express "trust proxy"). Only `true` behind a proxy you control: otherwise a caller could choose its own IP and dodge the per-IP limit |
| `TRIAGE_REVIEW_API_KEY` | none (required) | `gateway/.env` | The same value as the Python app's `REVIEW_API_KEY` (root `.env`). Sent as `X-API-Key` when the gateway forwards a review decision. An empty value counts as missing |

Endpoints:

- `GET /health` is liveness and checks nothing else: `200 {"status":"ok"}`.
- `GET /ready` pings Redis, runs `SELECT 1` on the gateway database and calls `GET {TRIAGE_SERVICE_URL}/ready`, in parallel, each with a 1.5 second timeout. A non-2xx answer from the Python service counts as down. (`/health` never touches Postgres.)

```json
200 {"status":"ready","checks":{"redis":"ok","triage":"ok","postgres":"ok"}}

503 {"status":"not_ready","checks":{"redis":"ok","triage":"down","postgres":"ok"},"reasons":{"triage":"status 503"}}
```

Reasons are short fixed phrases (`timeout`, `connection refused`, `host not found`, `authentication failed`, `database not found`, `unreachable`, `status 503`). They never include URLs or stack traces. Redis being down at startup does not stop the gateway; it keeps retrying and `/ready` answers 503 until Redis is back.

### Reviewer accounts: the gateway database and the reviewer CLI (M4.1a)

Human reviewers log in to the gateway with an email and password (see "Reviewer login" below). Accounts are created with this CLI only: there is no sign-up endpoint, and there is no UI yet. Machine clients still use API keys exactly as before.

**A separate database.** The existing Postgres server now holds a second database, `gateway`, owned by its own role, `gateway`. The role has no other powers (not a superuser, cannot create databases or roles) and can connect to no other database; no one but the superuser can connect to `gateway`. The Python app's role is the server's superuser (it is the image's bootstrap user), so it *can* technically reach `gateway`; the isolation is that the gateway's role cannot reach Python's data, and Python never has `GATEWAY_DATABASE_URL`.

- **Fresh volume:** `db/init/10-gateway-db.sh` runs once, when Postgres first starts, and creates the role and database from `db/gateway-db.sql` using `GATEWAY_DB_PASSWORD`.
- **Existing volume** (init scripts do not run again): set `GATEWAY_DB_PASSWORD` in the root `.env`, recreate the db container so it sees it (`docker compose up -d db`), then run `scripts/create_gateway_db.sh`. The SQL is idempotent: running it twice is safe, and it also resets the role's password to the current `GATEWAY_DB_PASSWORD`, so it doubles as password rotation. An unset or empty password is refused.

**Migrations.** Plain numbered SQL files in `gateway/migrations/` (`001_create_users.sql` creates `users`). The one-shot compose service `gateway-migrate` (same image as the gateway, `node dist/database/migrate.js`) runs when the stack starts, after the database is healthy, and the gateway starts only after it has finished successfully. The gateway itself never migrates. The runner records each applied file with its SHA-256 in `schema_migrations`, runs each file in its own transaction, holds a Postgres advisory lock so two runners cannot race, and **refuses to run** if an already-applied file was edited, has gone missing, or a new file is numbered below an applied one. To change the schema, add a new numbered file; never edit an applied one. Locally: `npm run migrate` in `gateway/` (needs `GATEWAY_DATABASE_URL`).

**Accounts.** `users` has `email` (stored trimmed and lower case, unique, and the database refuses anything else), `display_name` (1 to 100 characters), `password_hash` (an Argon2id PHC string), `role` (only `reviewer` for now), `disabled_at`, `password_changed_at` and timestamps. Passwords are hashed with **Argon2id** (19456 KiB of memory, 2 passes, 1 lane, the OWASP minimum; about 40 to 50 ms per hash on the development machine).

**Password rules** (length and a blocklist, no composition rules): 12 to 128 characters after Unicode NFC normalization; not the email address or the part before the `@` (any capitalisation); not one of about twenty very common passwords.

**The reviewer CLI** manages accounts from inside the gateway container (it is compiled into the image):

```bash
docker compose exec -it gateway node dist/scripts/reviewers.js create --email ada@example.com --name "Ada Lovelace"
docker compose exec -it gateway node dist/scripts/reviewers.js set-password --email ada@example.com
docker compose exec gateway node dist/scripts/reviewers.js disable --email ada@example.com
docker compose exec gateway node dist/scripts/reviewers.js enable --email ada@example.com
docker compose exec gateway node dist/scripts/reviewers.js list
# locally, inside gateway/ with GATEWAY_DATABASE_URL set:  npm run reviewers -- list
```

Passwords are **never** command-line arguments (they would land in shell history; `--password` is refused). `create` and `set-password` ask for the password with no echo, twice to confirm; when input is not a terminal (a pipe, a script) they read one line from it instead: `echo "$PASSWORD" | docker compose exec -T gateway node dist/scripts/reviewers.js create ...`. A duplicate or unknown email is a clear error with exit code 1; `disable` and `enable` are idempotent; `list` shows email, name, role, disabled yes/no and creation time, never a hash. `set-password` stamps `password_changed_at` and `disable` sets `disabled_at`; both also **end all of that reviewer's sessions** in Redis (the command prints how many; see "Reviewer login").

### Reviewer login: session cookies (M4.1b)

A reviewer logs in with the email and password from the CLI and then uses the reviewer routes with a **session cookie** instead of an API key. Machine clients are unchanged. Required settings: `GATEWAY_DATABASE_URL` (accounts), Redis (sessions) and `ALLOWED_ORIGINS` (see the settings table). **For plain-`http` local development also set `COOKIE_SECURE=false` in `gateway/.env`**; otherwise the browser (and `curl`'s cookie jar) will not keep the cookie. Production must keep it `true`.

```bash
# 1. Log in. -c saves the cookie jar; the Origin header is required (it must be one of ALLOWED_ORIGINS).
curl -i -c jar.txt -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{"email":"ada@example.com","password":"..."}'
# 200 {"user":{"id","email","display_name","role"},"expires_at":"..."}  and  Set-Cookie: tiq_session=...; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800

# 2. Who am I? (-b sends the cookie jar)
curl -b jar.txt localhost:3000/auth/me
# 3. Use the reviewer routes. Reads need nothing more; writes also need the Origin header.
curl -b jar.txt "localhost:3000/tickets?status=pending_review"
curl -b jar.txt -X POST -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"action":"approve"}' localhost:3000/tickets/<ticket_id>/review
# 4. Log out (idempotent: 204 every time, and the cookie is cleared)
curl -b jar.txt -c jar.txt -X POST -H 'Origin: http://localhost:5173' localhost:3000/auth/logout -i
```

| Request | Answer |
|---|---|
| `POST /auth/login` with the right email and password | `200` and the cookie. A **new** session every time; an old session cookie sent with the login is ended |
| wrong password, unknown email, or a disabled account | `401 {"message":"Invalid email or password"}`, identical for all three (and all three do the same password check, so timing does not tell them apart) |
| too many failed logins for the email or the IP | `429 {"message":"Too many failed attempts. Try again later."}` with `Retry-After`. Checked **before** any password hashing |
| malformed login body | `400 {"message":"Invalid login request"}` (email at most 254 characters, password at most 128, no other fields) |
| `POST /auth/login` or `/auth/logout`, or any cookie-authenticated write, with a missing or non-matching `Origin` | `403` |
| `GET /auth/me` with a valid session | `200 {"user":{...},"expires_at":"..."}`; otherwise `401` (an API key is not a session, so it also gets `401`) |
| `POST /auth/logout` | `204`, always |

**What a session can do:** exactly what a `reviewer` API client can: everything a submitter can, plus the dead-letter routes, the ticket read and review routes, and any job. Jobs a user submits are owned by that user (`user:<id>`); jobs submitted by clients keep their client name as owner, so nothing existing changes. If a request carries **both** an `Authorization: Bearer` key and a cookie, the key alone is used and the cookie is ignored. API-key requests never need an `Origin`.

**How sessions work.** The cookie holds a random 32-byte token. Redis stores the session under the **SHA-256 of the token** (`session:<hash>`), plus an index of each user's sessions (`user_sessions:<user id>`), so a copy of Redis holds nothing usable as a cookie. A session ends after `SESSION_IDLE_MINUTES` without use or `SESSION_ABSOLUTE_HOURS` after login, whichever comes first; use slides the idle timer but writes to Redis at most once a minute. **Every request also loads the user from Postgres:** if the account is gone or disabled, or its password changed after the session began, the session is refused and deleted. That per-request check is the guarantee; the CLI revoking sessions on `disable` and `set-password` is only clean-up, and a Redis outage at that moment cannot leave a disabled reviewer logged in. If Redis or Postgres cannot be reached the request fails closed with `503`.

**Login attempt limits.** Each login attempt is counted **first**, atomically, per IP (`LOGIN_MAX_FAILURES_PER_IP`) and per email (`LOGIN_MAX_FAILURES_PER_EMAIL`, stored under the SHA-256 of the email), in a fixed window of `LOGIN_WINDOW_MINUTES`; a count above the maximum is refused with `429` and `Retry-After` and does no password hashing, however many attempts arrive at the same moment (with a maximum of 5, exactly 5 of 50 simultaneous attempts are checked). A successful login deletes that email's counter and gives its attempt back to the IP counter, so at rest the counters mean failures. Login events are logged (`login outcome=failure reason=wrong_password user=<id> ip=...`) but **never the submitted email, the password, the cookie or the token**, because people sometimes type their password into the email box.

### API keys, roles and rate limits

Every gateway route needs `Authorization: Bearer <key>`, except **`GET /health` and `GET /ready`, which stay public** (orchestrators and uptime checks have no key, and they are not rate limited).

**Create a client key** (inside `gateway/`; nothing is written to disk):

```bash
npm run make-client-key -- alice submitter     # or: npm run make-client-key -- ops-team reviewer
```

It prints the key **once** (`tiq_` and 43 random characters; store it in a password manager, it cannot be recovered) and the registry entry for it, which holds only the SHA-256 of the key. Put the entries in `GATEWAY_CLIENTS` in `gateway/.env` as one line of JSON in single quotes:

```bash
cp gateway/.env.example gateway/.env     # first time only; gateway/.env is git-ignored
# GATEWAY_CLIENTS='[{"name":"alice","role":"submitter","key_sha256":"<64 hex>"},{"name":"ops-team","role":"reviewer","key_sha256":"<64 hex>"}]'
# RATE_LIMIT_PER_MINUTE=60
docker compose up -d --force-recreate gateway
```

`name` is 1 to 40 characters of `a-z`, `0-9` and `-`, unique. `role` is `submitter` or `reviewer`. At least one client is required: the gateway refuses to start, naming the problem and never printing a value, if the registry is missing or invalid. If `gateway/.env` is missing, compose stops with `env file .../gateway/.env not found`: copy `gateway/.env.example` as above. To rotate a key, make a new one and replace that entry; to remove a client, delete its entry.

| Role | Can do |
|---|---|
| `submitter` | `POST /tickets`, and `GET /jobs/:id` for **its own jobs** |
| `reviewer` | everything a submitter can, plus `GET /dead-letters`, `POST /dead-letters/:id/retry`, and `GET /jobs/:id` for **any** job |

| Problem | Answer |
|---|---|
| no key, malformed header, unknown key | `401 {"detail":"Missing or invalid API key"}` with `WWW-Authenticate: Bearer`. The key is never logged or echoed |
| right key, wrong role | `403 {"detail":"Not allowed"}` |
| a submitter asks for a job that belongs to another client, or that has no client (created before M3.5a) | `404 {"detail":"Job not found"}`, the same as a job that does not exist, so job ids cannot be probed. A reviewer can read them |

**Rate limit.** Each client may make `RATE_LIMIT_PER_MINUTE` requests (default 60, 1 to 10000) in a fixed one-minute window that starts at its first request. Every response to an authenticated request carries `RateLimit-Limit` and `RateLimit-Remaining`. The request after the limit gets `429 {"detail":"Rate limit exceeded"}` with `Retry-After` (seconds until the window resets). Requests rejected with 401 are not counted, and neither are `/health` and `/ready`. Every other request counts, including ones that end in 403 or 404. If Redis is unreachable the limiter answers `503`. There is no per-IP limit.

```bash
curl -i -H "Authorization: Bearer $TIQ_KEY" localhost:3000/jobs/00000000-0000-4000-8000-000000000000
# HTTP/1.1 404 ... RateLimit-Limit: 60  RateLimit-Remaining: 59
```

Responses also carry the security headers from `helmet` (such as `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Content-Security-Policy`), and `X-Powered-By` is removed. Plain HTTP only: put a TLS-terminating proxy in front before exposing the port.

### Reviewer routes: read and review tickets through the gateway

These four routes are for the **`reviewer` role only** (a submitter gets `403 {"detail":"Not allowed"}`). The gateway checks the request, then makes a **new** request to the Python service and passes the answer on. It never forwards your `Authorization` header or any other header of yours; the only credential Python sees is `TRIAGE_REVIEW_API_KEY`. `POST /tickets` (intake) is unchanged.

| Gateway route | Forwards to | Checked first (otherwise `400`, nothing sent to Python) |
|---|---|---|
| `GET /tickets?status=&limit=` | `GET /tickets` | `status` is `triaged`, `pending_review`, `approved`, `edited` or `rejected`; `limit` is 1 to 200. Any other query parameter is dropped |
| `GET /tickets/:id` | `GET /tickets/{id}` | `id` is a UUID |
| `GET /tickets/reference/:reference` | `GET /tickets/reference/{reference}` | `reference` looks like `TKT-7K3M9Q` (`TKT-` and 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`) |
| `POST /tickets/:id/review` | `POST /tickets/{id}/review` | `id` is a UUID; body is `{"action": "approve" \| "edit" \| "reject", "edited_reply"?, "note"?}`, `edit` needs a non-blank `edited_reply`, unknown fields are rejected; content type `application/json` (else `415`) |

```bash
curl -s -H "Authorization: Bearer $TIQ_REVIEWER_KEY" "localhost:3000/tickets?status=pending_review&limit=10"
curl -s -H "Authorization: Bearer $TIQ_REVIEWER_KEY" localhost:3000/tickets/<ticket_id>
curl -s -H "Authorization: Bearer $TIQ_REVIEWER_KEY" localhost:3000/tickets/reference/TKT-7K3M9Q
curl -s -X POST -H "Authorization: Bearer $TIQ_REVIEWER_KEY" -H 'Content-Type: application/json' \
  -d '{"action":"edit","edited_reply":"Your account unlocks after 1 hour.","note":"shortened"}' \
  localhost:3000/tickets/<ticket_id>/review
```

The request and response shapes are Python's (see "Reviewing a flagged ticket" and `GET /tickets` above). Answers:

| Python answers | The gateway answers |
|---|---|
| `2xx`, `400`, `404`, `409`, `422` | the same status and JSON body |
| `401`, or `503` "Review is disabled" (the gateway's review key is wrong or Python has none) | `502 {"detail":"Triage service rejected the gateway"}` and a warning in the gateway log. Fix `TRIAGE_REVIEW_API_KEY` |
| any other `503` (database or Claude trouble) | `503 {"detail":"Triage service unavailable; please retry"}` |
| any other status, or an answer that is not JSON | `502 {"detail":"Triage service error"}` |
| no connection, or no answer within 10 s (reads) or 30 s (review) | `503 {"detail":"Triage service unavailable; please retry"}` |

**The reviewer is set by the gateway, not the client.** The body you send for `POST /tickets/:id/review` is only the decision (`action`, `edited_reply`, `note`). A body that carries its own `reviewer` field is refused with `400` (unknown field), so nobody can review in someone else's name. The gateway adds `reviewer` itself before forwarding: `{"id": "user:<uuid>", "name": <display name>}` for a session, `{"id": "client:<name>", "name": <name>}` for an API key. It travels in the JSON body, not a header, because names can be any Unicode and headers cannot carry that safely. Ticket answers that include a `reviewed_by` are checked (an object with `id` and `name`, or `null`; a malformed one is a `502`). The log line for a review adds `reviewer=<namespaced id>`, never the name or the email.

Python's error text, stack traces and internal URLs never reach the client. Each call is logged with the client name, the route, Python's status and the duration, never ticket text or keys. **A review decision does not yet record which reviewer made it**: Python sees only the gateway's key. That comes with user login in M4.

### Ticket intake and job status

`POST /tickets` checks a ticket, stores it on the BullMQ queue named `triage`, and answers at once with a job id. `GET /jobs/:id` reports where that job is. This is not the same as the Python `POST /triage`: it does not wait for the AI work, and it returns no category or reply.

```bash
curl -i -X POST http://localhost:3000/tickets \
  -H "Authorization: Bearer $TIQ_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"subject": "Cannot log in", "body": "I forgot my password.", "customer_id": "cust-42"}'
```

```
HTTP/1.1 202 Accepted
Location: /jobs/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34

{"job_id":"3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34","reference":"TKT-7K3M9Q","status":"queued","status_url":"/jobs/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"}
```

`reference` is the ticket's human-friendly reference. Since M4.2 the **gateway** makes it at accept time (the same format Python always used: `TKT-` and six characters with no `0 O 1 I L`) and sends it to Python with the ticket, so the answer can carry it at once. A repeat with the same `Idempotency-Key` returns the same reference. Python still makes one itself if a ticket arrives without it (older jobs, direct calls).

```bash
curl -H "Authorization: Bearer $TIQ_KEY" http://localhost:3000/jobs/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34
```

```json
{"job_id": "3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34", "status": "queued", "received_at": "2026-11-20T10:00:00.000Z"}
```

When the job is `done` the response also has `"result"`: the Python service's full triage answer (`ticket_id`, `reference`, `category`, `urgency`, `confidence`, `routing_target`, `suggested_reply`, `kb_sources`, `needs_human_review`, `review_reason`). A ticket flagged for human review is still `done`: the worker only reports that triage ran, and the ticket waits in Postgres as `pending_review`. When a job is `failed` it has `"error"`, a short fixed reason with no URL, stack trace or ticket text.

```json
{"job_id": "3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34", "status": "done", "received_at": "2026-11-20T10:00:00.000Z",
 "result": {"ticket_id": "9b1d...", "reference": "TIQ-7K2M9Q", "category": "account", "needs_human_review": true, "...": "..."}}

{"job_id": "...", "status": "failed", "received_at": "...", "error": "rejected by triage service (422)"}
```

| `status` | Meaning (BullMQ state) |
|---|---|
| `queued` | waiting, delayed (including waiting to retry), prioritized or waiting-children |
| `running` | active (the worker is waiting for the Python service) |
| `done` | completed |
| `failed` | failed |

Rules and limits:

| Rule | Result |
|---|---|
| `subject`: text, trimmed, 1 to 200 characters. `body`: text, trimmed, 1 to 5000. `customer_id`: optional text, at most 100. Any other field is rejected | otherwise `400 {"detail":"Invalid ticket","errors":[{"field":"subject","problem":"must not be empty"}]}`. The messages never repeat what you sent |
| Content type must be `application/json` | otherwise `415` |
| Optional header `Idempotency-Key`: 1 to 100 characters, letters, digits and `_ . : -` only | otherwise `400 {"detail":"Invalid Idempotency-Key","errors":[...]}`; the value is never echoed. See "Idempotency-Key" below |
| JSON body at most 100 kb | otherwise `413`, before the body is parsed |
| Malformed JSON | `400 {"detail":"Request body is not valid JSON"}` |
| The job could not be stored within about 2 seconds (Redis down) | `503 {"detail":"Ticket intake is temporarily unavailable; please retry"}`. It never answers 202 for a ticket it did not store |
| `GET /jobs/:id` with an id that is not a UUID | `400 {"detail":"Malformed job id"}` |
| `GET /jobs/:id` with an unknown id | `404 {"detail":"Job not found"}` |
| `GET /jobs/:id` while Redis is down | `503` |

The field names match the Python `TicketIn`, but the gateway is stricter: the Python service accepts an empty subject or body, no length limits, and `"customer_id": null`, while the gateway rejects all three. A ticket the gateway accepts is always valid for the Python service. Finished jobs stay in Redis for 1 day (failed ones for 30 days, see the dead-letter list below) and are then removed.

#### Idempotency-Key: so a client retry never creates a second job

Send `Idempotency-Key: <your key>` on `POST /tickets` whenever the client might repeat the request: a timeout, a dropped connection, a `503`, a user double-clicking. **Use one key per ticket and reuse the same key on every retry of that ticket.** A new key for a retry is a new ticket. A random UUID generated when the ticket is first created is a good key.

```bash
curl -i -X POST localhost:3000/tickets \
  -H "Authorization: Bearer $TIQ_KEY" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: 9d6c1c2e-7f43-4c58-b0a7-3f1f0f6a2b10' \
  -d '{"subject": "Cannot log in", "body": "I forgot my password."}'
```

| Request | Answer |
|---|---|
| first use of the key | `202`, a new job, as usual |
| same key, same ticket again (within 24 hours) | `202` with the **same** `job_id`, `status_url` and `Location`, plus the header `Idempotent-Replayed: true`. No new job |
| same key, a different ticket | `422 {"detail":"Idempotency-Key was already used with a different ticket"}` |
| the queue write failed or timed out | `503`, and the key is released, so the retry with the same key works |
| Redis unreachable | `503`, within about 2 seconds |
| no header | exactly as before: every request is a new job |

"Same ticket" means the same `subject`, `body` and `customer_id` after trimming (a SHA-256 of those three fields in a fixed order), so extra whitespace does not matter and any real change does. A key is remembered for 24 hours (`SET idem:<key> NX EX 86400` in Redis). The `status` in a replayed `202` is always `queued`, as in the first answer: poll `status_url` for the real state. A key does **not** retry a failed job: it keeps pointing at the same job, so use `POST /dead-letters/:id/retry` for that.

**Idempotency keys are per client.** They are stored as `idem:<client name>:<key>`, so the same `Idempotency-Key` from two clients is two different keys and creates two jobs. (Keys stored under the old format, `idem:<key>`, simply expire within 24 hours.)

**How the two hops fit together.** The key protects the client-to-gateway hop (no duplicate job). The `ticket_id` protects the gateway-to-Python hop (no duplicate ticket): the worker sends its job id, which is the same on every attempt and every dead-letter retry, and the Python service answers from the existing ticket instead of triaging again. Together a ticket is triaged and saved once even when the client retries, the worker is killed after Python saved the ticket, or a dead-lettered job is retried.

### Public ticket form: `POST /public/tickets` (M4.2)

The door customers use: **no account and no key**. Anyone on the internet can call it, and every accepted ticket costs a paid model call, so it is mostly abuse and spend control. It is **off** unless `PUBLIC_FORM_ENABLED=true` (otherwise it answers `404`, like a route that does not exist). There is no UI yet: the form page and the Turnstile widget come in M4.3c.

```bash
curl -i -X POST http://localhost:3000/public/tickets \
  -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -H "Idempotency-Key: form-$(date +%s)" \
  -d '{"name":"Ada","email":"ada@example.com","subject":"Invoice","message":"Where is my invoice?","turnstile_token":"XXXX.DUMMY.TOKEN.XXXX"}'
# 202 {"reference":"TKT-7K3M9Q","message":"Thanks, we received your message."}
```

- **Body** (strict, unknown fields are `400`): `name` 1 to 100, `email` valid and at most 254 (stored trimmed and lower-cased), `subject` and `message` with the same limits as an API ticket (200 and 5000), `turnstile_token` 1 to 2048, and `website` (a hidden honeypot field, optional). The body limit on this route is **16 KB** (the rest of the gateway allows 100 KB).
- **`Idempotency-Key` is required** (the form makes one per page load, so a double click makes one ticket). Same key and same message: the original `202` again. Same key, different message: `422`, as for `POST /tickets`.
- **The answer is only a reference and a thank-you.** Never a job id, never anything about the AI or the processing. The ticket is owned by the built-in client `public-form` (that name is refused in `GATEWAY_CLIENTS`), with `customer_id` `public-form`; reviewers see the customer's `customer_name` and `customer_email` when they read the ticket. **The name and email are never sent to the model.**

**The checks, in order, cheapest first and money last.** Each runs only if the earlier ones passed:

| # | Check | Refused with |
|---|-------|--------------|
| 1 | `PUBLIC_FORM_ENABLED` | `404` |
| 2 | **Origin** must be in `ALLOWED_ORIGINS` (a cheap filter, *not* security: a script can send any Origin) | `403` |
| 3 | Schema, and the `Idempotency-Key` header | `400` with field errors |
| 4 | **Replay**: this key already completed with the same message: the original `202`, with nothing below used (no limit slot, no Turnstile call, no cap slot). The Turnstile token and the honeypot are not part of "the same message", so a retry with a new or spent token still works | `202` / `422` |
| 5 | **Honeypot**: `website` filled in: a normal-looking `202` with a random fake reference, nothing queued (it still counts toward the IP limit) | fake `202` |
| 6 | **Per-IP limit**: `PUBLIC_MAX_PER_IP_PER_HOUR` (default 5) per client IP per hour, counted first and atomically, like the login limit | `429` + `Retry-After` |
| 7 | **Turnstile** (Cloudflare) verifies the token server-side. If Cloudflare cannot be reached, times out (5 s) or answers 5xx, the form **fails closed** | `403` "Verification failed, please try again." / `503` "Please try again in a moment." |
| 8 | **Daily cap**: `PUBLIC_DAILY_CAP` (default 200) accepted public tickets per UTC day, reserved atomically; the slot is given back if the ticket is not queued after all | `503` + `Retry-After` until UTC midnight, "We're receiving too many messages today. Please try again tomorrow." |
| 9 | Claim the idempotency key and queue the ticket, exactly like `POST /tickets` | `202` |

The cap is **after** Turnstile on purpose: a bot with no valid token can never use up the cap and lock real customers out. The cap is the hard ceiling on what the form can cost in a day, whatever else goes wrong.

**Enable it locally with Turnstile's test keys** (in `gateway/.env`; the dummy secret is for testing only and never for production):

```
PUBLIC_FORM_ENABLED=true
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA   # always passes; accepts only the dummy token XXXX.DUMMY.TOKEN.XXXX
# 2x0000000000000000000000000000000AA always fails; 3x0000000000000000000000000000000AA answers "token already spent"
ALLOWED_ORIGINS=http://localhost:5173
```

The dummy keys always report the hostname `example.com` and no action, so leave `TURNSTILE_EXPECTED_HOSTNAMES` and `TURNSTILE_EXPECTED_ACTION` empty locally (or set the hostname to `example.com`). With real keys set them to your site's hostname and `public_ticket`. Settings: `PUBLIC_FORM_ENABLED`, `TURNSTILE_SECRET_KEY` (required when enabled, or the gateway will not start), `TURNSTILE_VERIFY_URL`, `TURNSTILE_EXPECTED_HOSTNAMES`, `TURNSTILE_EXPECTED_ACTION`, `PUBLIC_MAX_PER_IP_PER_HOUR`, `PUBLIC_DAILY_CAP`; see `gateway/.env.example`. Real Turnstile keys come with M6.

**Logs** carry `public_ticket outcome=<accepted|replay|honeypot|rate_limited_ip|turnstile_failed|turnstile_unavailable|daily_cap|invalid> reference=... ip=... turnstile_errors=...`. **Never** the name, email, subject, message, token or secret.

### The worker and retries

The worker runs inside the gateway process. For each job it sends `{subject, body, customer_id, ticket_id}` (the job id as `ticket_id`, the same on every attempt) to `POST {TRIAGE_SERVICE_URL}/triage` and waits up to `TRIAGE_TIMEOUT_MS`. A job gets at most **8 attempts**. After a failed attempt that is worth repeating, it waits `max(Retry-After, 10 s x 2^(n-1))` after attempt n, never more than 5 minutes: 10, 20, 40, 80, 160, 300 and 300 seconds, about **15 minutes** of retrying in total (long enough for a Python restart or a short Claude outage).

| Answer from the Python service | What happens | Why |
|---|---|---|
| `2xx` with JSON | job `done`, the JSON is the result | |
| `503`, `429` | retry, waiting at least the `Retry-After` it sent (seconds or an HTTP date) | The service says "later". Python sends `503` with `Retry-After: 30` when Claude or the database is unavailable |
| `502`, `504`, timeout, connection refused, DNS failure, connection reset | retry (no `Retry-After` is read) | The service or a proxy in front of it is unreachable or slow |
| `400`, `404`, `409`, `422` and any other `4xx` | `failed` at once | The request itself is wrong. Sending it again gets the same answer |
| `500`, `501` and any other `5xx` | `failed` at once | **A `500` is not retried on purpose.** The Python service returns `500` for problems a retry cannot fix, such as an invalid Anthropic key or a bug, and every retry would repeat several paid LLM calls |
| `2xx` that is not valid JSON | `failed` at once | Something is wrong with the service, not the load |

When the attempts run out the job is `failed` with the last reason. Failure reasons are short fixed phrases such as `triage service unavailable (503)`, `timeout` or `rejected by triage service (422)`: never a URL, response body or ticket text. The worker logs one line per attempt (job id, attempt, outcome, duration) and never the ticket text. Jobs queued before M3.3 keep the options they were queued with (one attempt, no backoff), and jobs queued before M3.4a keep their 5 attempts and 7-day retention.

**Stopping the gateway.** On `SIGTERM` the gateway stops taking work and waits for the jobs that are running, then exits. Docker only waits 10 seconds by default and then kills the container. A job that was running at that moment is not lost, but BullMQ only notices after the job's lock runs out (about a minute) and then runs it again, so the Python service can receive the same ticket twice. To avoid this, give the gateway a stop timeout longer than `TRIAGE_TIMEOUT_MS` (`docker-compose.yml` sets `stop_grace_period: 130s` on the gateway; keep it longer than `TRIAGE_TIMEOUT_MS`).

### Dead letters: tickets that failed for good

A job is `failed` only when it is final: its attempts are used up, or the Python service rejected it in a way a retry cannot fix (such as a `422`). Between retries a job is `delayed`, not `failed`. BullMQ keeps final failures in its **failed set**, and the gateway uses that set as the dead-letter list instead of a separate store: nothing to keep in sync, and a failed job keeps its data, its reason and its id. Failed jobs stay for **30 days** and are then removed (jobs already in Redis keep the retention they were added with). Without this list, a ticket that failed after 15 minutes of retries was only reachable if you knew its id, and expired quietly after a week.

When a job reaches `failed` the worker logs one WARN line: `dead-letter job=<id> attempts_made=<n> reason=<short reason>`. It never contains ticket text.

**`GET /dead-letters?limit=20&offset=0`** lists failed jobs, newest failure first. `limit` is 1 to 100 (default 20), `offset` is 0 or more; anything else is `400`.

```bash
curl -s -H "Authorization: Bearer $TIQ_REVIEWER_KEY" "localhost:3000/dead-letters?limit=2"
```

```json
{
  "items": [
    {
      "job_id": "2261b984-fe29-4c2b-9b82-4f26d2460d72",
      "failed_at": "2026-11-20T09:15:02.311Z",
      "received_at": "2026-11-20T09:12:40.870Z",
      "attempts_made": 5,
      "reason": "triage service unreachable (connection refused)",
      "subject": "Cannot log in",
      "body": "I get an error when I try to sign in.",
      "customer_id": "cust-42"
    }
  ],
  "total": 1,
  "limit": 2,
  "offset": 0
}
```

(Illustrative values.) `customer_id` is `null` when the ticket had none. `reason` is the short one-line reason, never a stack trace. `503` if Redis cannot be reached within about 2 seconds, like the other endpoints.

**`POST /dead-letters/:id/retry`** puts a failed job back on the queue under the **same job id**, with all its attempts again, and answers `202 {"job_id", "status": "queued", "status_url": "/jobs/<id>"}`. Keep polling the same `status_url`.

```bash
curl -s -X POST -H "Authorization: Bearer $TIQ_REVIEWER_KEY" localhost:3000/dead-letters/2261b984-fe29-4c2b-9b82-4f26d2460d72/retry
```

| Case | Answer |
|---|---|
| id is not a UUID | `400 {"detail":"Malformed job id"}` |
| no such job | `404 {"detail":"Job not found"}` |
| the job exists but is not failed (queued, running, done, or already retried) | `409 {"detail":"Job is not in the dead-letter list"}` |
| Redis unreachable | `503` |

Retrying twice in a row gives `409` the second time, never a second copy: BullMQ checks and moves the job in one atomic step. **These two endpoints are for the `reviewer` role only** (see below) because the list shows ticket text. Each item also shows the `client` that submitted the job (`null` for jobs from before API clients existed).

**Remaining gaps.** A request whose `Idempotency-Key` is lost from Redis before the job is persisted (a flush or a crash before the append-only file was written) can let one duplicate job through. The Python hop does not depend on it: even then the worker's job id keeps one ticket per job. 

Tests (Vitest; lint is oxlint): `npm test`, `npm run test:e2e` and `npm run lint` inside `gateway/`. Tests that need a real Redis (including the worker retry tests, which take about 30 seconds because they use the real backoff) are skipped unless `REDIS_TEST_URL` is set, for example:

```bash
docker run --rm -d --name gw-redis-test -p 6390:6379 redis:8.10.3-alpine
REDIS_TEST_URL=redis://localhost:6390 npm run test:e2e
docker stop gw-redis-test
```

## Security

| What is protected | How |
|---|---|
| Access to the gateway | Every route except `/health` and `/ready` needs `Authorization: Bearer <key>`. Keys are `tiq_` plus 32 random bytes; the gateway stores only their SHA-256 (`GATEWAY_CLIENTS`) and compares with a constant-time check. A missing, malformed or unknown key is a `401` and is never logged or echoed |
| What each client may do | Two roles: a `submitter` can submit tickets and read its own jobs; a `reviewer` can also read any job, list and retry dead letters, and read and review tickets. Anything else is a `403` |
| Other clients' jobs | A submitter asking for a job that is not theirs (or has no owner) gets the same `404` as for a job that does not exist, so job ids cannot be probed |
| Duplicate and replayed requests | Idempotency keys are namespaced per client (`idem:<client>:<key>`), so one client cannot read or collide with another's |
| Abuse and cost | A per-client fixed-window rate limit counted in Redis (`RateLimit-*` headers, `429` with `Retry-After`); 401s are rejected before counting. Bodies over 100 kb are refused. There is no per-IP limit (see Known gaps) |
| Browser-facing hardening | `helmet` security headers on every response; `X-Powered-By` is removed |
| Python service | Not published: it has no port on the host and is reached only by the gateway on the compose network. The gateway makes a fresh request for each call and never forwards a client's `Authorization` or other headers |
| The review key | `REVIEW_API_KEY` is Python's; the gateway holds the same value as `TRIAGE_REVIEW_API_KEY` and adds it itself, so no client ever sees or needs it. A wrong gateway key shows up as a `502`, not as a leak |
| Network exposure | Every published port (gateway 3000, Postgres 5433, Redis 6380) is bound to `127.0.0.1`. Put a TLS-terminating proxy in front before exposing the gateway |
| Secrets | Split per service: the root `.env` (Anthropic, Voyage, the review key) is read only by the Python app; `gateway/.env` (the client hashes, the gateway's review key) only by the gateway. Both are git-ignored and excluded from the images. Error messages name a setting, never its value |
| Reviewer sessions | A random 256-bit token in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie; stored in Redis only as its SHA-256; a new token at every login (no session fixation); idle and absolute lifetimes; the user row is re-checked on every request, so a disabled reviewer or a changed password ends the session immediately. Cookie-authenticated writes also need an `Origin` that matches `ALLOWED_ORIGINS` (on top of `SameSite`). Failed logins are limited per IP and per email, before any hashing |
| Reviewer passwords | Hashed with Argon2id (parameters stored inside each hash, so they can be raised later and old hashes still verify); never stored or logged in clear; never a command-line argument; the CLI never prints a hash. The accounts live in the gateway's own database, whose role cannot reach Python's data |
| Ticket text | Not written to logs: the worker, passthrough and dead-letter log lines carry only ids, counts, statuses and short fixed phrases |

## Troubleshooting

- **Every ticket fails; Python logs show a 401 from Anthropic.** The `ANTHROPIC_API_KEY` is expired or wrong. The Python service answers `500` (a bad key is not something a retry fixes), so the gateway fails each job at once with `triage service error (500)` and the jobs land in the dead-letter list. Put a valid key in the root `.env`, **recreate** the app so it reads it (`docker compose up -d --force-recreate app`; a plain restart keeps the old environment), then replay the dead letters: `GET /dead-letters` with the reviewer key, and `POST /dead-letters/<job_id>/retry` for each.
- **Docker builds crash Docker Desktop's virtual machine.** This happened on Linux with Docker Desktop. Use the native Docker Engine instead of the Desktop VM. The images themselves build fine.
- **The gateway will not start.** Run `docker compose logs gateway`. If compose says `env file .../gateway/.env not found`, create it: `cp gateway/.env.example gateway/.env` and fill it in. If the gateway exits with `Invalid gateway configuration: ...`, the message names the setting, such as `GATEWAY_CLIENTS is invalid (entry 1: role must be "submitter" or "reviewer")` or `TRIAGE_REVIEW_API_KEY is missing`. It never prints the value.
- **Every request is a 401.** The key you send is empty, or its hash is not in `GATEWAY_CLIENTS`. Check that the shell variable is set (`echo ${#KEY}` should print 47), that you pasted the entry made for that key, and that you recreated the gateway after editing `gateway/.env` (`docker compose up -d --force-recreate gateway`).
- **Reviews answer `502 Triage service rejected the gateway`.** `TRIAGE_REVIEW_API_KEY` in `gateway/.env` differs from `REVIEW_API_KEY` in the root `.env`, or the latter is empty. Make them equal and recreate both services.
- **`gateway-migrate` fails, so the gateway never starts.** Run `docker compose logs gateway-migrate`. `password authentication failed` or `role "gateway" does not exist` means the gateway role is missing or its password differs from `GATEWAY_DATABASE_URL`: on an existing database volume run `scripts/create_gateway_db.sh` (it also resets the password to `GATEWAY_DB_PASSWORD`), and make sure both values are the same. `migration ... was changed after it was applied` means someone edited an applied file: restore it and add a new numbered migration instead. Compose itself refusing to start with `Set GATEWAY_DB_PASSWORD in .env` means that line is missing from the root `.env`.
- **`POST /auth/login` answers `403`.** The `Origin` header is missing or not in `ALLOWED_ORIGINS`. `ALLOWED_ORIGINS` is empty by default, which refuses every login: set it in `gateway/.env` (for example `http://localhost:5173`) and recreate the gateway. `curl` sends no `Origin` unless you add `-H 'Origin: ...'`.
- **Login returns 200 but the browser or `curl -b` does not stay logged in.** On plain `http` the browser drops a `Secure` cookie. Set `COOKIE_SECURE=false` in `gateway/.env` for local development only (and recreate the gateway); keep it `true` in production.
- **A reviewer cannot log in and gets `429`.** Five failed attempts (default) in 15 minutes block that email, and 20 block that IP, even for the right password, until the window ends (`Retry-After` says how long). There is nothing to reset: the counters expire by themselves in Redis, so wait for `Retry-After`.
- **`/ready` says `postgres: down`.** The gateway cannot reach its database (the reason names the cause: `connection refused`, `authentication failed`, `database not found`). `/health` stays up, so the container is not restarted for this.
- **The Voyage free tier is slow.** It allows 3 embedding requests per minute, and the Python service waits for its own limiter (`VOYAGE_RPM`), so ingesting the KB takes about a minute and a triage can take far longer than a normal call. If jobs time out and retry under load, lower `WORKER_CONCURRENCY`, raise `TRIAGE_TIMEOUT_MS`, or use a paid Voyage account and raise `VOYAGE_RPM`. The smoke test takes minutes on the free tier.

## Known gaps

- **`reviewed_by` is only as trustworthy as the review key.** Python records whoever the gateway says is reviewing; anyone holding `TRIAGE_REVIEW_API_KEY` could name any reviewer. Reviews made before M4.1c have no author (`reviewed_by` is `null`).
- **API-key routes have no per-IP limit.** Their limit is per client, so one leaked key can use that client's whole allowance. The public form has its own per-IP limit, but it is per address (an IPv6 user can rotate within a /64, and many people behind one NAT share one limit) and the daily cap is the real ceiling. Behind a proxy set `TRUST_PROXY=true`, or every caller looks like the proxy.
- **One shared review key** for every reviewer client. Rotating it means editing both `.env` files and recreating two services.
- **Redis is a single instance** with appendonly persistence but no replica or backup. A lost Redis loses queued jobs, idempotency keys and the dead-letter list (tickets already saved in Postgres are safe).
- **The rate limit is a fixed window**, so a client can make up to twice the limit across a window edge.
- **Registry changes need a restart,** and there is no key-rotation tooling beyond replacing an entry.
- **Anything on the compose network can call Python without a key** (only reviews need one).
- **There is no reviewer UI yet** (M4.3), no password reset by email, no multi-factor authentication and no "remember me". Reply delivery by email is planned (M4.4).
- **Failing logins on someone's email locks that email out for one window.** After 5 failures (default) in 15 minutes, logins for that email are refused for the rest of the window, even with the right password, so anyone who knows a reviewer's email can lock them out briefly. Accepted for now: the alternative (not limiting per email) lets passwords be guessed.
- **The failure limits use the client IP,** which behind a proxy is only right with `TRUST_PROXY=true`, and then only if the proxy is trusted and sets `X-Forwarded-For` itself (M6). There is still no per-IP limit on anything else, for the public form (M4.2) that will be needed.
- **Python's database role is the server's superuser,** so it can technically read the gateway database. Only the reverse is blocked. A least-privilege role for Python would need a change on the Python side.
- **The gateway database shares the Postgres server** (and its volume and backups) with Python's. A server outage takes both down.
- **Migrations only go forward.** There are no down migrations.

## Project layout

```
app/
  main.py              FastAPI app, startup migrations, /health and /ready
  api/                 POST /triage, GET /tickets, POST /tickets/{id}/review, auth.py, deps.py (get_graph)
  graph/               the LangGraph nodes, build.py (the wiring), checkpointer.py, review.py (resume helpers)
  kb/                  Voyage embeddings, rate limiter, KB search, ingest script
  tickets/             saving and reading tickets
  db.py, migrations.py engine and sessions; running Alembic from the app
  models.py            Pydantic models and the graph state
alembic/               migrations (the only place that creates tables)
gateway/               NestJS gateway: config, auth/roles/rate limit, intake, worker, dead letters, idempotency, reviewer routes,
                       reviewer accounts (src/users, src/database, migrations/, src/scripts/reviewers.ts)
scripts/e2e_smoke.py   end-to-end smoke test through the gateway (stdlib only; spends model calls)
scripts/create_gateway_db.sh  creates the gateway's database and role in an existing Postgres volume
db/                    gateway-db.sql (idempotent role and database setup) and init/ (runs it on a new volume)
docker-compose.yml     the stack; docker-compose.debug.yml publishes the Python app on 127.0.0.1:8000
evals/                 labelled tickets, deterministic scoring, and the eval runner
tests/                 unit tests; tests/integration/ needs a real Postgres
```

## Status and limitations

This is a working prototype, not a finished product.

- Measured by a 20-ticket labelled eval set; see Evals: results below. The 0.6 confidence threshold and the 0.65 distance cutoff are provisional, and the grader prompt has not been measured, set from a handful of examples.
- **The confidence score is the model's own.** It is not calibrated, so treat it as a rough signal.
- **The public form exists but has no UI** (M4.2): `POST /public/tickets` with a Turnstile check, a per-IP limit and a daily spend cap, off by default. The form page and widget come in M4.3c; replies are not emailed yet (M4.4).
- **Human review works through the API, with gaps.** Flagged tickets pause, and `POST /tickets/{id}/review` approves, edits or rejects them. There is no reviewer interface, there is one shared review key (the reviewer who decided is recorded as `reviewed_by`, taken from whoever the gateway authenticated), and edits are not captured as feedback. Python's own read endpoints need no key, but the Python port is closed; reviewers read and review through the gateway, which requires a reviewer key. If the app fails after the paused run has been resumed but before the decision is saved, the run has finished while the row still says `pending_review`, and a retry gets a `409`.
- **A bad raw resume value strands a ticket.** Always resume through `resume_review()`, which takes a validated `ReviewDecision`. Resuming the graph by hand with an invalid value raises an error, and LangGraph then replays that same bad value on every later resume, so the ticket can no longer be reviewed.
- **Migration `0002` is applied to a database the next time the app starts against it**, because migrations run at startup. It adds the ticket reference, the review columns and the `approved`, `edited` and `rejected` statuses.
- **Authentication and limits are on the gateway only.** The gateway needs an API key and limits each client. The Python service has no per-client authentication of its own; it is protected by not being published, so only the gateway (and anything else on the compose network) can reach it. Each ticket costs up to three Claude calls and one embedding call (four with the KB grader).
- **Prompt injection is only partly covered.** Ticket text goes into the prompts. The KB grader also reports `injection_suspected`, and a suspected ticket is flagged for a human. But that check only runs on tickets that reach the grader, meaning tickets with at least one candidate article; a ticket with no candidate article, or one the grader call failed on, is not checked. A check on every ticket at intake is future work. The grader is itself an LLM reading the ticket, and its detection has not been measured.
- **Long replies are cut off, and flagged.** Every Claude call is capped at `LLM_MAX_TOKENS` (700, about 500 words). A draft that runs longer stops mid-sentence. The app detects this (Claude's stop reason is `max_tokens`) and flags the ticket for review with the reason "Draft reply was cut off at the token limit.", but the cut-off text is still returned as `suggested_reply`. If the classifier or critic is cut off, the request fails with a `500`. How often cut-offs happen has not been measured yet, so the cap itself is untuned.
- **A failed save loses the response, unless the request carried a `ticket_id`.** If the database goes down after the work is done, the client gets a 503. Without a `ticket_id` the triage has to be paid for again on retry, and for a flagged ticket the graph has already paused, so a paused thread exists with no ticket row and nothing can find it. With a `ticket_id` (the gateway always sends one) the retry rebuilds the answer from the saved run and saves the row, with no new model calls.
- **A small sample KB.** Only 5 FAQ articles are included, and there are no tools for managing articles beyond the ingest script.
- **Run one instance.** Migrations are not locked against concurrent starts.
- **Checkpoint rows pile up.** Every run writes checkpoint rows to Postgres, and there is no retention policy yet, so they are never deleted.

## More

- [`NOTES.md`](NOTES.md): a walkthrough of how each part works, plus known gaps and what has been fixed.
- [`ROADMAP.md`](ROADMAP.md): the full list of planned work.
