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
        route --> gate{"confidence at or above threshold?"}
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

Why flagged: a ticket is sent to a human when the classifier is unsure ("Low classifier confidence."), the critic objects, or the knowledge base cannot ground the reply. The KB reasons are "No knowledge base match." (nothing retrieved), "KB article does not answer the ticket." (articles were retrieved but `grade_kb` kept none), "KB relevance check unavailable." (the grader call failed; the request still succeeds) and "Possible prompt injection in the ticket." (the grader suspects the ticket tries to instruct or redirect an automated system; this reason overrides every other one, and the ticket still gets its normal draft) and "Knowledge base unavailable." (retrieval failed). `kb_grade` is internal state and is not part of the API response.

### Components

```mermaid
flowchart LR
    app["FastAPI app<br/>(uvicorn)"] --> anthropic["Anthropic API<br/>classify, draft, critique"]
    app --> voyage["Voyage AI<br/>embeddings"]
    app --> pg[("Postgres + pgvector<br/>kb_documents, tickets, graph checkpoints")]
    app --> alembic["Alembic migrations<br/>run at startup"]
    alembic --> pg
```

## API

| Endpoint | Purpose |
|---|---|
| `POST /triage` | Triage a ticket and save the result |
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
evals/                 labelled tickets, deterministic scoring, and the eval runner
tests/                 unit tests; tests/integration/ needs a real Postgres
```

## Status and limitations

This is a working prototype, not a finished product.

- **Measured only by a small eval.** An eval harness and a 20-ticket labelled set exist (see Evals), but no results are recorded here yet, reply quality is checked only by phrase matching, and there are no calibration or retrieval-recall numbers. The 0.6 confidence threshold and the 0.65 distance cutoff are provisional, and the grader prompt has not been measured, set from a handful of examples.
- **The confidence score is the model's own.** It is not calibrated, so treat it as a rough signal.
- **Human review works through the API, with gaps.** Flagged tickets pause, and `POST /tickets/{id}/review` approves, edits or rejects them. There is no reviewer interface, no reviewer identity is recorded, there is one shared API key, and edits are not captured as feedback. Reading tickets (`GET /tickets...`) needs no key. If the app fails after the paused run has been resumed but before the decision is saved, the run has finished while the row still says `pending_review`, and a retry gets a `409`.
- **A bad raw resume value strands a ticket.** Always resume through `resume_review()`, which takes a validated `ReviewDecision`. Resuming the graph by hand with an invalid value raises an error, and LangGraph then replays that same bad value on every later resume, so the ticket can no longer be reviewed.
- **Migration `0002` is applied to a database the next time the app starts against it**, because migrations run at startup. It adds the ticket reference, the review columns and the `approved`, `edited` and `rejected` statuses.
- **No authentication except on the review endpoint, and no request limits.** The other endpoints are open, and each ticket costs up to three Claude calls and one embedding call.
- **Prompt injection is only partly covered.** Ticket text goes into the prompts. The KB grader also reports `injection_suspected`, and a suspected ticket is flagged for a human. But that check only runs on tickets that reach the grader, meaning tickets with at least one candidate article; a ticket with no candidate article, or one the grader call failed on, is not checked. A check on every ticket at intake is future work. The grader is itself an LLM reading the ticket, and its detection has not been measured.
- **Long replies are cut off, and flagged.** Every Claude call is capped at `LLM_MAX_TOKENS` (700, about 500 words). A draft that runs longer stops mid-sentence. The app detects this (Claude's stop reason is `max_tokens`) and flags the ticket for review with the reason "Draft reply was cut off at the token limit.", but the cut-off text is still returned as `suggested_reply`. If the classifier or critic is cut off, the request fails with a `500`. How often cut-offs happen has not been measured yet, so the cap itself is untuned.
- **A failed save loses the response.** If the database goes down after the work is done, the client gets a 503 and the triage has to be paid for again on retry. For a flagged ticket it is worse: the graph has already paused, so a paused thread exists with no ticket row, and nothing can find it.
- **A small sample KB.** Only 5 FAQ articles are included, and there are no tools for managing articles beyond the ingest script.
- **Run one instance.** Migrations are not locked against concurrent starts.
- **Checkpoint rows pile up.** Every run writes checkpoint rows to Postgres, and there is no retention policy yet, so they are never deleted.

## More

- [`NOTES.md`](NOTES.md): a walkthrough of how each part works, plus known gaps and what has been fixed.
- [`ROADMAP.md`](ROADMAP.md): the full list of planned work.
