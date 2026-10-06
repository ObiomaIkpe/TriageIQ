# TriageIQ: How It Works and Open Gaps

Notes from a walkthrough of the code. Changes made since: the classifier and critic now use `with_structured_output`, the critic now receives the KB context, and KB search now has a 0.5 distance cutoff (see "Resolved" and "Test results" below).

## How it works

A request to the triage endpoint runs a LangGraph workflow (`app/graph/build.py`):

```
classify -> route -> [confidence >= threshold?]
    yes -> retrieve_kb -> draft_reply_node -> critique -> END
    no  -> flag_low_confidence -> END
```

The graph has one conditional edge, after `route`. The threshold is `low_confidence_threshold` in `app/config.py` (default 0.6); exactly the threshold counts as confident. Low-confidence tickets skip retrieval, drafting and critique, so their response has `suggested_reply: null` and `kb_sources: []`. `triage_ticket` (`app/api/triage.py`) builds the initial state `{"ticket": ticket}`, calls `triage_graph.invoke(...)`, and maps the final state to a `TriageResult`.

`GraphState` (`app/models.py`) is a `TypedDict` with `total=False`, so the state can start with only `ticket`. Each node adds its own fields.

| Node | File | Writes | Notes |
|---|---|---|---|
| `classify` | `graph/classifier.py` | `classification` | LLM, temperature 0, `with_structured_output(ClassificationResult)` |
| `route` | `graph/router.py` | `routing_target` | No LLM. Map lookup by category, plus `-urgent` suffix for high/critical |
| `retrieve_kb` | `graph/kb_retrieval.py` | `kb_context` | Vector search on subject + body: up to 3 matches within 0.5 cosine distance (may be none). Each match is a `KbMatch` (`topic`, `content`, `distance`), and the API returns them as-is in `kb_sources` |
| `draft_reply_node` | `graph/reply_draft.py` | `draft_reply` | LLM, temperature 0.3, grounded in `kb_context` |
| `flag_low_confidence` | `graph/flag_low_confidence.py` | `needs_human_review`, `review_reason` | No LLM. Runs instead of the three nodes below when confidence is under the threshold |
| `critique` | `graph/critic.py` | `needs_human_review`, `review_reason` | Flags without an LLM call if the KB failed or had no match. Otherwise an LLM reviews the draft against the ticket, classification and `kb_context` |

The node is named `draft_reply_node` because LangGraph does not allow a node name to match a state key (`draft_reply`).

## Knowledge base (`app/kb/`)

The `retrieve_kb` node finds up to 3 KB articles close in meaning to the ticket, using semantic search.

- **Embedding (`store.py: embed_text`).** Text is sent to Voyage AI (`voyage-3`), which returns 1024 numbers. `input_type` is `"document"` when storing articles and `"query"` when searching, because Voyage tunes the embeddings differently for each.
- **Storage.** Articles live in Postgres, table `kb_documents` (`id`, `topic`, `content`, `embedding VECTOR(1024)`), using the `pgvector` extension.
- **Search (`search_similar`).** Keeps articles with `embedding <=> query_embedding < MAX_DISTANCE` (cosine distance, `MAX_DISTANCE = 0.5`), ordered closest first, `LIMIT 3`. It returns a `list[KbMatch]` (`topic`, `content`, `distance`), which may be shorter than 3 or empty. The drafter and critic see each match as a `- [topic] content` line (`graph/formatting.py`).
- **Seeding (`ingest.py`).** A script, run with `python -m app.kb.ingest`. It is safe to re-run: documents are identified by `topic`, and re-running updates an existing topic's content and embedding in place instead of adding a row. It applies the database migrations, then embeds and saves 5 sample FAQ documents (password reset, billing cycle, account lockout, subscription cancellation, two-factor authentication). It sleeps 20 seconds between documents to stay under the Voyage free-tier limit of 3 requests per minute.
- **Nothing close enough.** If the table is empty or no article is within the cutoff, search returns `[]` and the drafter and critic see "No relevant knowledge base articles found."

## Database layer (`app/db.py`, `app/migrations.py`, `alembic/`)

- **SQLAlchemy 2.0 (sync) with psycopg 3.** `app/db.py` holds the engine, the session factory and `get_session()` (one transaction: commit on success, roll back on error). `DATABASE_URL` is converted from `postgresql://` to `postgresql+psycopg://`, because the plain form would select `psycopg2`, which is not installed. Creating the engine does not connect.
- **ORM models:** `KbDocumentRow` (`app/kb/orm.py`, with pgvector's `Vector(1024)` column) and `TicketRow` (`app/tickets/orm.py`). They are named `...Row` to keep them apart from the Pydantic API models. The stores map rows to the Pydantic models.
- **The schema belongs to Alembic.** `alembic/versions/0001_initial_schema.py` is the only place that creates tables, the `vector` extension and the indexes. It skips anything that already exists and removes duplicate topics (keeping the lowest `id`), so it adopts a database created by the earlier raw-SQL setup.
- **Migrations run at startup:** `main.py` calls `run_migrations()` through the retry wrapper. If the database never comes up the app still boots and logs an error. `python -m app.kb.ingest` also runs them first. Migrations can be run by hand with `alembic upgrade head`, which reads `DATABASE_URL` from the settings.
- **Changing the schema:** edit the model, then `alembic revision --autogenerate -m "..."`, review the generated file, commit it. `alembic check` reports drift between the models and the database.
- **Docker:** the Dockerfile copies `alembic.ini` and `alembic/`, so the container can migrate itself. A guard test checks this.
- **Limits.** Nothing locks migrations, so run one app instance at a time. A failed migration is retried and then ignored, which leaves the app running with missing tables until it is fixed.
- **Tests.** Most tests need no database. The ones in `tests/integration/` run against a real Postgres and are skipped unless `TEST_DATABASE_URL` is set, for example `TEST_DATABASE_URL=postgresql://triageiq:triageiq@localhost:5433/triageiq_test`. The database name must end in `_test`; it is created if missing and wiped before each test. They never use `DATABASE_URL`.
- **Port gotcha.** In `.env`, `DATABASE_URL` points at `localhost:5432`, but the compose database is published on host port `5433`, and `5432` is a different local Postgres. Inside compose the app uses `db:5432` and is unaffected. Commands run from the host need the right port.

## Tickets (`app/tickets/`)

Every successful triage is saved, so results can be read back and, later, paused for human review.

- **Table `tickets`** (created by the Alembic migration that runs at startup, see "Database layer"): `id` (UUID, primary key), `status`, the original `subject`, `body` and `customer_id`, the triage result (`category`, `urgency`, `confidence`, `routing_target`, `suggested_reply`, `kb_sources` as JSONB, `needs_human_review`, `review_reason`), and `created_at` / `updated_at`. Index on `(status, created_at)`.
- **Statuses.** `pending_review` when the result is flagged for human review, otherwise `triaged`.
- **The ticket id is created before the graph runs** (`uuid4()` in `app/api/triage.py`), so a paused graph run can later use it as its LangGraph thread id. `POST /triage` returns it as `ticket_id`.
- **When rows are saved.** After a successful graph run only, and low-confidence tickets are saved too. If the graph fails, nothing is saved.
- **Endpoints.** `GET /tickets?status=<triaged|pending_review>&limit=<1-200, default 50>` lists newest first. `GET /tickets/{ticket_id}` returns one ticket, 404 if missing, 422 for a malformed id.
- **A failed save returns 503.** A database that is unreachable (`sqlalchemy.exc.OperationalError`, or the driver's `psycopg.OperationalError` it wraps) gets a 503 with `Retry-After`, the same as LLM outages. Note that the triage work has already been done and paid for when the save fails, and the response is lost with it.
- **Shared database helper:** `app/db.py` (engine, session factory, `get_session`), used by both the KB and ticket stores.

## Gaps and things to consider

### 1. Wasted LLM call on low-confidence tickets (RESOLVED)
Previously the reply was drafted before the critic checked confidence, so a low-confidence ticket paid for a draft that was then flagged anyway. Resolved by a conditional edge after `route`: tickets under the threshold go to `flag_low_confidence` and make no KB, draft or critic calls.

### 2. `.get()` fallbacks in `triage_ticket` cannot trigger
The graph is linear and every path sets `routing_target`, `kb_context`, `draft_reply`, `needs_human_review` and `review_reason`. The defaults (`"general-queue"`, `[]`, `True`, ...) are harmless but would hide a bug if a node stopped writing a field. Consider `final_state["..."]` so a missing field fails loudly.

### 3. Nodes return the full state
Each node returns `{**state, "key": value}`. LangGraph only needs the changed keys, so `{"key": value}` is enough. The spread can cause update conflicts if parallel branches are added later (for example, running `route` and `retrieve_kb` in parallel).

### 4. Sequential LLM latency
A request makes up to three sequential LLM calls (classify, draft, critique), so per-request latency adds up. The blocking `invoke` is not a problem: the endpoint is a plain `def`, which FastAPI runs in a threadpool.

### 5. Model ID
All three LLM calls use `claude-sonnet-4-6`. Confirm this is the intended model, and consider moving it to one config constant instead of repeating it in three files.

### 6. Prompt injection
Ticket text goes straight into the classifier, drafter and critic prompts, and the draft is fed to the critic. A hostile ticket could try to steer the classification or the review verdict. The human-review flag helps, but the critic is itself an LLM reading attacker-influenced text.

### 7. Critic `reason` can be empty
`CritiqueResult.reason` is an empty string when no review is needed. `triage_ticket` handles that with `review_reason or None`. The low-confidence shortcut uses a fixed string, `"Low classifier confidence."`.

### 8. Knowledge base gaps
- **Voyage rate limit at request time.** `ingest.py` sleeps 20 seconds between documents because of a 3 requests-per-minute free-tier limit. But every triage request also makes one Voyage embedding call in `search_similar`. On the free tier, the endpoint would hit the limit after about 3 requests in a minute. Not tested; this follows from the limit stated in the `ingest.py` comment.
- **`topic` is never returned (RESOLVED).** `search_similar` now selects `topic`, `content` and the cosine distance and returns `KbMatch` objects, so the drafter, the critic and the API's `kb_sources` can all show which article a snippet came from. `kb_sources` changed from a list of strings to a list of `{topic, content, distance}` objects.
- **New database connection on every call (RESOLVED).** The raw `get_connection()` is gone. The stores use a SQLAlchemy engine, which pools connections (`pool_pre_ping` enabled), and `CREATE EXTENSION vector` now runs once, in the migration.
- **Ingest is not idempotent (RESOLVED).** `kb_documents` had no unique constraint on `topic`, so running `python -m app.kb.ingest` twice inserted every document twice. Now the initial Alembic migration deletes existing duplicates (keeping the lowest `id` per topic) and creates a unique index on `topic`, and `add_document` is an upsert (`ON CONFLICT (topic) DO UPDATE` content and embedding). The migration is safe on a database that already has the tables, so an existing database with duplicates is cleaned up the first time it runs.
- **Extra latency.** Each retrieval is a Voyage API call plus a Postgres query, even though no LLM is involved.
- **Missing keys fail late.** `voyage_api_key` and `database_url` come from `app/config.py`, where every setting has a default (the API keys default to empty strings). A missing key does not stop the app from starting; it fails at the first Voyage call.
- **The table is not created at startup (RESOLVED).** The app now applies the Alembic migrations at startup with retry (`app/main.py`, `app/migrations.py`, `app/kb/bootstrap.py`), so a fresh database gets its tables without running the ingest script. If the database never comes up, the app still boots and KB lookups degrade to a human-review flag.
- **The cutoff rests on a small sample.** Verified end to end, but only two real-match samples back it. See "Resolved" below.

### 9. Not yet checked
- Error handling: if any node or LLM call raises, `invoke` raises and the endpoint returns a 500. There are no retries or fallbacks.
- Whether the endpoint should return 200 or 201 depends on whether a triage record is persisted. Currently it only computes a result, so 200 is correct.

## Resolved

### Critic could not see the KB
The critic's prompt told it to flag claims "not supported by the knowledge base context", but `critique` never passed it the KB articles. It could not verify anything, so it flagged replies that were fully supported by the KB. Fixed in `app/graph/critic.py`: `kb_context` is now formatted (same fallback text as `draft_reply.py`) and included in the critic's prompt.

### KB search returned irrelevant articles (similarity cutoff)
Search used to return the top 3 articles regardless of relevance, so a password question also got lockout and 2FA paragraphs, and a hardware refund question got 3 unrelated articles. Fixed in `app/kb/store.py` with `MAX_DISTANCE = 0.5`. The value came from measuring cosine distances (read-only script, 5 Voyage calls) from 5 test queries to the 5 sample articles:

| Query | Closest article | Distance | 2nd closest |
|---|---|---|---|
| Password reset (real match) | password reset | 0.332 | 0.565 (lockout) |
| Cancel subscription (real match) | subscription cancellation | 0.351 | 0.652 |
| Charged twice (partly related) | billing cycle | 0.642 | 0.747 |
| Hardware refund (irrelevant) | account lockout | 0.735 | 0.771 |
| Weather in Paris (unrelated) | account lockout | 0.817 | 0.833 |

Real matches landed at about 0.33-0.35 and everything else at 0.565 or higher, so 0.5 sits inside the gap.

**Status: verified end-to-end (2026-10-05).** After rebuilding the stack, the lockout ticket returned one matching article in `kb_sources` and a grounded reply that the critic cleared. The shipping ticket returned `kb_sources: []`, a reply that invented no policy, and `needs_human_review: true`. The 0.5 value still rests on only two real-match samples, so retune it when the KB grows or if real tickets with longer bodies score between 0.4 and 0.5. If it is too strict, the result is empty context and a human-review flag, which is the safe direction.

## Test results

Run against the rebuilt Docker stack with real Anthropic and Voyage calls.

1. **"Cannot log in" / forgot password** (a KB article covers it). Classified account / low / 0.97, routed to `account-management`. The reply was grounded in the KB. Before the critic fix it was flagged for review with the reason that no KB was provided. After the fix: `needs_human_review: false`, `review_reason: null`.
2. **"Hardware refund"** (no KB article covers it). Classified billing / high / 0.82, routed to `billing-team-urgent`. The drafter said it did not have the policy and escalated to a specialist rather than inventing one. The critic flagged it for review, noting that the KB has nothing on hardware refunds and that the category is questionable.

3. **Lockout, after the cutoff** ("account locked after too many attempts"). Classified account / high / 0.95, routed to `account-management-urgent`. `kb_sources` held only the lockout article. The reply was grounded and `needs_human_review: false`.
4. **Shipping, after the cutoff** ("package has not arrived"). Classified other / medium / 0.82, routed to `general-queue`. `kb_sources: []`. The reply invented no policy and escalated, and the critic flagged it (questionable category, unsupported escalation promise).

Together these show the critic clears supported replies and still flags unsupported ones.

### Findings from the tests
- **No similarity cutoff, seen in practice.** Test 1 got lockout and 2FA paragraphs the customer did not ask about. Test 2 got 3 articles, none relevant. These tests ran before the cutoff was added (see "Resolved").
- **Category design.** A broken-hardware refund request has no obvious category among billing / technical / account / other. The classifier chose billing and the critic questioned it. This is a category design question, not a code bug.
- **Content gap.** The KB has no hardware refund article, so tickets like test 2 will always need a human until one is added.
- **No shipping category.** A missing-package ticket was classified `other`, and the critic flagged it. Add a `shipping` category in M2.
- **Test coverage.** Only two tickets were tried, and only one run each. This is a sanity check, not a measurement of reliability.

## Roadmap

The full, exhaustive roadmap lives in `ROADMAP.md` (sections A-L, with a suggested build order).

## Answers to earlier questions

- Blocking: this is a plain def, not async def. FastAPI runs plain def endpoints in a threadpool, so the blocking invoke does not freeze the event loop. The blocking-invoke concern formerly listed as gap #4 is therefore a non-issue for the current code. It would only apply if someone changed this to async def without switching to ainvoke. The note has been corrected.
- Status code: the endpoint uses the default 200, which is correct since nothing is persisted.
- Unused import: GraphState is used for the annotation on line 11, so that import is fine.