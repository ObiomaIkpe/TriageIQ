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
- a **`ticket_id`** and a short, human-friendly **`reference`** (such as `TKT-7K3M9Q`): every result is saved, and can be read back from `/tickets`

## Architecture

### How a ticket flows

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

### Components

```mermaid
flowchart LR
    client([Client]) --> gateway["NestJS gateway<br/>(M3.3: ticket intake + triage worker)"]
    gateway --> app
    gateway --- redis[("Redis<br/>the triage queue, beside the gateway")]
    app["FastAPI app<br/>(uvicorn)"] --> anthropic["Anthropic API<br/>classify, draft, critique"]
    app --> voyage["Voyage AI<br/>embeddings"]
    app --> pg[("Postgres + pgvector<br/>kb_documents, tickets, graph checkpoints")]
    app --> alembic["Alembic migrations<br/>run at startup"]
    alembic --> pg
```

The gateway accepts tickets, queues them, and its worker sends each one to the FastAPI app and keeps the result (see [Gateway (M3)](#gateway-m3)). The gateway does not yet add authentication, rate limits or duplicate protection, so the app stays reachable on port 8000 and clients can still call `POST /triage` directly.

## API

| Endpoint | Purpose |
|---|---|
| `POST /triage` | Triage a ticket and save the result. An optional `ticket_id` (a UUID) makes it safe to send the same ticket again: it is triaged and saved at most once (see below) |
| `GET /tickets?status=&limit=` | List tickets, newest first. `status` is `triaged`, `pending_review`, `approved`, `edited` or `rejected`; `limit` is 1 to 200 (default 50) |
| `GET /tickets/{ticket_id}` | One ticket, with the original subject and body, and the review fields (`final_reply`, `review_note`, `reviewed_at`, all null until a reviewer decides). 404 if missing, 422 for a malformed id |
| `GET /tickets/reference/{reference}` | The same record, found by its short reference (such as `TKT-7K3M9Q`). 404 if unknown |
| `POST /tickets/{ticket_id}/review` | Approve, edit or reject a ticket that is waiting for review. Needs the `X-API-Key` header (see below) |
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

```bash
curl -X POST localhost:8000/tickets/<ticket_id>/review \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your REVIEW_API_KEY>" \
  -d '{"action": "edit", "edited_reply": "Your account unlocks after 1 hour.", "note": "shortened"}'
```

- `action` is `approve`, `edit` (needs a non-empty `edited_reply`) or `reject`; `note` is optional. The response is the updated ticket (`status` is `approved`, `edited` or `rejected`, with `final_reply`, `review_note` and `reviewed_at` filled in).
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
- **A flagged ticket pauses the graph for a human.** `human_review` calls LangGraph's `interrupt()` only when `needs_human_review` is true; unflagged tickets pass straight through. `POST /triage` still answers normally: a paused run counts as a success and is saved as `pending_review`, and the pause marker never reaches the client. The paused state lives in the Postgres checkpointer under the ticket id, so it survives a restart. `app/graph/review.py` has `is_paused()` and `resume_review()` (approve, edit or reject). **There is no endpoint to call them yet.** When a run resumes, LangGraph runs the `human_review` node again from its start, so nothing before the `interrupt()` call may have side effects.
- **Structured output, not text parsing.** The classifier and critic use `with_structured_output` with Pydantic models.
- **The schema belongs to Alembic, with one exception.** The app applies migrations at startup. Data access uses SQLAlchemy 2.0 with pgvector's `Vector` type. The LangGraph checkpoint tables are the exception: the checkpointer library creates and upgrades them itself.
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
pytest                         # unit tests; no database or API keys needed
```

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

On 2026-10-21 the 5 KB articles were rewritten as realistic help articles (120 to 200 words each). Their policy sentences are unchanged and sit inside the new text word for word, and they were written without reading the eval set. Re-run the ingest to load them (see Quickstart).

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

`gateway/` is a NestJS service that will sit in front of the Python app. The plan: take a ticket instantly, queue the slow AI work, make sure no ticket is lost if something restarts, and add authentication and rate limits at the front door. It is built in steps (M3.1 to M3.5). **So far it starts, checks its settings, reports health, accepts tickets onto a queue (M3.2), and runs a worker that sends each queued ticket to the Python service `POST /triage` and stores the result on the job (M3.3).** There is no authentication or rate limiting yet (M3.5).

Redis holds the queue (compose service `redis`, appendonly persistence on, published on host port **6380**, bound to localhost).

Run it with the rest of the stack (`docker compose up --build -d`); the gateway is published on port **3000**. To run it by itself you need Node 24:

```bash
cd gateway
cp .env.example .env     # set REDIS_URL=redis://localhost:6380 if you use the compose Redis
npm install
npm run start:dev
```

Settings. The first three are required; the last two are optional and have defaults. The gateway refuses to start if one is missing or invalid, and names each bad setting without printing its value:

| Variable | Local default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the gateway listens on (1 to 65535) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection (`redis://` or `rediss://`). In Docker, compose sets `redis://redis:6379` |
| `TRIAGE_SERVICE_URL` | `http://localhost:8000` | Base URL of the Python service. In Docker, compose sets `http://app:8000` |
| `WORKER_CONCURRENCY` | `2` | How many tickets the worker sends to the Python service at the same time (1 to 10). Each ticket costs several Claude calls and a Voyage call, so this also protects the API rate limits |
| `TRIAGE_TIMEOUT_MS` | `120000` | How long the worker waits for one answer from the Python service (1000 to 600000). A triage run makes several LLM calls, so this is generous |

Endpoints:

- `GET /health` is liveness and checks nothing else: `200 {"status":"ok"}`.
- `GET /ready` pings Redis and calls `GET {TRIAGE_SERVICE_URL}/ready`, in parallel, each with a 1.5 second timeout. A non-2xx answer from the Python service counts as down.

```json
200 {"status":"ready","checks":{"redis":"ok","triage":"ok"}}

503 {"status":"not_ready","checks":{"redis":"ok","triage":"down"},"reasons":{"triage":"status 503"}}
```

Reasons are short fixed phrases (`timeout`, `connection refused`, `host not found`, `unreachable`, `status 503`). They never include URLs or stack traces. Redis being down at startup does not stop the gateway; it keeps retrying and `/ready` answers 503 until Redis is back.

### Ticket intake and job status

`POST /tickets` checks a ticket, stores it on the BullMQ queue named `triage`, and answers at once with a job id. `GET /jobs/:id` reports where that job is. This is not the same as the Python `POST /triage`: it does not wait for the AI work, and it returns no category or reply.

```bash
curl -i -X POST http://localhost:3000/tickets \
  -H 'Content-Type: application/json' \
  -d '{"subject": "Cannot log in", "body": "I forgot my password.", "customer_id": "cust-42"}'
```

```
HTTP/1.1 202 Accepted
Location: /jobs/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34

{"job_id":"3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34","status":"queued","status_url":"/jobs/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"}
```

```bash
curl http://localhost:3000/jobs/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34
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

**Keys are not scoped per client until M3.5 adds authentication.** Two clients that pick the same key share it, and a client that guesses another's key gets that job id back. Use random keys.

**How the two hops fit together.** The key protects the client-to-gateway hop (no duplicate job). The `ticket_id` protects the gateway-to-Python hop (no duplicate ticket): the worker sends its job id, which is the same on every attempt and every dead-letter retry, and the Python service answers from the existing ticket instead of triaging again. Together a ticket is triaged and saved once even when the client retries, the worker is killed after Python saved the ticket, or a dead-lettered job is retried.

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
curl -s "localhost:3000/dead-letters?limit=2"
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
curl -s -X POST localhost:3000/dead-letters/2261b984-fe29-4c2b-9b82-4f26d2460d72/retry
```

| Case | Answer |
|---|---|
| id is not a UUID | `400 {"detail":"Malformed job id"}` |
| no such job | `404 {"detail":"Job not found"}` |
| the job exists but is not failed (queued, running, done, or already retried) | `409 {"detail":"Job is not in the dead-letter list"}` |
| Redis unreachable | `503` |

Retrying twice in a row gives `409` the second time, never a second copy: BullMQ checks and moves the job in one atomic step. **These two endpoints have no login until M3.5 and expose ticket text, which is why the compose file binds the gateway port to localhost only.** Do not publish port 3000 beyond localhost before M3.5.

**Remaining gaps.** A request whose `Idempotency-Key` is lost from Redis before the job is persisted (a flush or a crash before the append-only file was written) can let one duplicate job through. The Python hop does not depend on it: even then the worker's job id keeps one ticket per job. Keys are not scoped per client until M3.5.

Tests (Vitest; lint is oxlint): `npm test`, `npm run test:e2e` and `npm run lint` inside `gateway/`. Tests that need a real Redis (including the worker retry tests, which take about 30 seconds because they use the real backoff) are skipped unless `REDIS_TEST_URL` is set, for example:

```bash
docker run --rm -d --name gw-redis-test -p 6390:6379 redis:8.10.3-alpine
REDIS_TEST_URL=redis://localhost:6390 npm run test:e2e
docker stop gw-redis-test
```

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
gateway/               NestJS gateway (M3.3: config, Redis, /health, /ready, POST /tickets, GET /jobs/:id, triage worker)
evals/                 labelled tickets, deterministic scoring, and the eval runner
tests/                 unit tests; tests/integration/ needs a real Postgres
```

## Status and limitations

This is a working prototype, not a finished product.

- Measured by a 20-ticket labelled eval set; see Evals: results below. The 0.6 confidence threshold and the 0.65 distance cutoff are provisional, and the grader prompt has not been measured, set from a handful of examples.
- **The confidence score is the model's own.** It is not calibrated, so treat it as a rough signal.
- **Human review works through the API, with gaps.** Flagged tickets pause, and `POST /tickets/{id}/review` approves, edits or rejects them. There is no reviewer interface, no reviewer identity is recorded, there is one shared API key, and edits are not captured as feedback. Reading tickets (`GET /tickets...`) needs no key. If the app fails after the paused run has been resumed but before the decision is saved, the run has finished while the row still says `pending_review`, and a retry gets a `409`.
- **A bad raw resume value strands a ticket.** Always resume through `resume_review()`, which takes a validated `ReviewDecision`. Resuming the graph by hand with an invalid value raises an error, and LangGraph then replays that same bad value on every later resume, so the ticket can no longer be reviewed.
- **Migration `0002` is applied to a database the next time the app starts against it**, because migrations run at startup. It adds the ticket reference, the review columns and the `approved`, `edited` and `rejected` statuses.
- **No authentication except on the review endpoint, and no request limits.** The other endpoints are open, and each ticket costs up to three Claude calls and one embedding call.
- **Prompt injection is only partly covered.** Ticket text goes into the prompts. The KB grader also reports `injection_suspected`, and a suspected ticket is flagged for a human. But that check only runs on tickets that reach the grader, meaning tickets with at least one candidate article; a ticket with no candidate article, or one the grader call failed on, is not checked. A check on every ticket at intake is future work. The grader is itself an LLM reading the ticket, and its detection has not been measured.
- **Long replies are cut off, and flagged.** Every Claude call is capped at `LLM_MAX_TOKENS` (700, about 500 words). A draft that runs longer stops mid-sentence. The app detects this (Claude's stop reason is `max_tokens`) and flags the ticket for review with the reason "Draft reply was cut off at the token limit.", but the cut-off text is still returned as `suggested_reply`. If the classifier or critic is cut off, the request fails with a `500`. How often cut-offs happen has not been measured yet, so the cap itself is untuned.
- **A failed save loses the response, unless the request carried a `ticket_id`.** If the database goes down after the work is done, the client gets a 503. Without a `ticket_id` the triage has to be paid for again on retry, and for a flagged ticket the graph has already paused, so a paused thread exists with no ticket row and nothing can find it. With a `ticket_id` (the gateway always sends one) the retry rebuilds the answer from the saved run and saves the row, with no new model calls.
- **A small sample KB.** Only 5 FAQ articles are included, and there are no tools for managing articles beyond the ingest script.
- **Run one instance.** Migrations are not locked against concurrent starts.
- **Checkpoint rows pile up.** Every run writes checkpoint rows to Postgres, and there is no retention policy yet, so they are never deleted.

## More

- [`NOTES.md`](NOTES.md): a walkthrough of how each part works, plus known gaps and what has been fixed.
- [`ROADMAP.md`](ROADMAP.md): the full list of planned work.
