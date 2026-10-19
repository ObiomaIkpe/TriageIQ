# TriageIQ: How It Works and Open Gaps

Notes from a walkthrough of the code. Changes made since: the classifier and critic now use `with_structured_output`, the critic now receives the KB context, and KB search now has a 0.5 distance cutoff (see "Resolved" and "Test results" below).

## How it works

A request to the triage endpoint runs a LangGraph workflow (`app/graph/build.py`):

```
classify -> route -> [confidence >= threshold?]
    yes -> retrieve_kb -> draft_reply_node -> critique -> human_review -> END
    no  -> flag_low_confidence -> human_review -> END
```

The graph has one conditional edge, after `route`. The threshold is `low_confidence_threshold` in `app/config.py` (default 0.6); exactly the threshold counts as confident. Low-confidence tickets skip retrieval, drafting and critique, so their response has `suggested_reply: null` and `kb_sources: []`. `triage_ticket` (`app/api/triage.py`) builds the initial state `{"ticket": ticket}`, calls `invoke(...)` on the graph it gets from `get_graph` (built at startup, with `thread_id` = the ticket id), and maps the final state to a `TriageResult`.

`GraphState` (`app/models.py`) is a `TypedDict` with `total=False`, so the state can start with only `ticket`. Each node adds its own fields.

| Node | File | Writes | Notes |
|---|---|---|---|
| `classify` | `graph/classifier.py` | `classification` | LLM, temperature 0, `with_structured_output(ClassificationResult)` |
| `route` | `graph/router.py` | `routing_target` | No LLM. Map lookup by category, plus `-urgent` suffix for high/critical |
| `retrieve_kb` | `graph/kb_retrieval.py` | `kb_context` | Vector search on subject + body: up to 3 matches within 0.5 cosine distance (may be none). Each match is a `KbMatch` (`topic`, `content`, `distance`), and the API returns them as-is in `kb_sources` |
| `draft_reply_node` | `graph/reply_draft.py` | `draft_reply`, `draft_truncated` | LLM, temperature 0.3, grounded in `kb_context`. `draft_truncated` is true when Claude's stop reason was `max_tokens` |
| `flag_low_confidence` | `graph/flag_low_confidence.py` | `needs_human_review`, `review_reason` | No LLM. Runs instead of the three nodes below when confidence is under the threshold |
| `critique` | `graph/critic.py` | `needs_human_review`, `review_reason` | Flags without an LLM call if the KB failed, had no match, or the draft was cut off at the token limit (all applicable reasons are joined). Otherwise an LLM reviews the draft against the ticket, classification and `kb_context` |

| `human_review` | `graph/human_review.py` | `review_decision`, `final_reply` | No LLM. Returns `{}` unless `needs_human_review`. If flagged it calls `interrupt()` with a plain-dict payload (reason, suggested reply, category, urgency, routing target) and waits for a `ReviewDecision` (`approve` / `edit` / `reject`). `final_reply` is the draft on approve, the edited text on edit, `None` on reject (also `None` on approve when there was no draft) |

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
- **The schema belongs to Alembic, with one exception.** `alembic/versions/0001_initial_schema.py` is the only place that creates our tables, the `vector` extension and the indexes. It skips anything that already exists and removes duplicate topics (keeping the lowest `id`), so it adopts a database created by the earlier raw-SQL setup. The exception is the LangGraph checkpoint tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`): the `langgraph-checkpoint-postgres` library owns them and creates and upgrades them itself in `PostgresSaver.setup()` (see "Graph startup and checkpointing"). They are deliberately not in our migrations or ORM models.
- **Migrations run at startup:** `main.py` calls `run_migrations()` through the retry wrapper. If the database never comes up the app still boots and logs an error. `python -m app.kb.ingest` also runs them first. Migrations can be run by hand with `alembic upgrade head`, which reads `DATABASE_URL` from the settings.
- **Changing the schema:** edit the model, then `alembic revision --autogenerate -m "..."`, review the generated file, commit it. `alembic check` reports drift between the models and the database.
- **Docker:** the Dockerfile copies `alembic.ini` and `alembic/`, so the container can migrate itself. A guard test checks this.
- **Limits.** Nothing locks migrations, so run one app instance at a time. A failed migration is retried and then ignored, which leaves the app running with missing tables until it is fixed. Every run also writes checkpoint rows (see "Graph startup and checkpointing") and nothing prunes them yet.
- **Tests.** Most tests need no database. The ones in `tests/integration/` run against a real Postgres and are skipped unless `TEST_DATABASE_URL` is set, for example `TEST_DATABASE_URL=postgresql://triageiq:triageiq@localhost:5433/triageiq_test`. The database name must end in `_test`; it is created if missing and wiped before each test. They never use `DATABASE_URL`.
- **Port gotcha.** In `.env`, `DATABASE_URL` points at `localhost:5432`, but the compose database is published on host port `5433`, and `5432` is a different local Postgres. Inside compose the app uses `db:5432` and is unaffected. Commands run from the host need the right port.

## Graph startup and checkpointing (`app/graph/checkpointer.py`, `app/api/deps.py`, `app/main.py`)

- **The graph is built at startup, not at import.** `build_triage_graph(checkpointer=None)` compiles the graph with the given checkpointer. Importing `app.graph.build` no longer touches the database. The startup hook (`main.py`) applies the migrations, then creates the checkpointer, compiles the graph and stores it on `app.state.triage_graph`. On shutdown it closes the connection pool.
- **A Postgres checkpointer.** `create_checkpointer()` opens a `psycopg` connection pool (autocommit and dict rows, which the library requires) and calls `PostgresSaver.setup()` once. If the database cannot be reached it fails after 5 seconds and closes the pool, so nothing is left behind.
- **`thread_id` = `ticket_id`.** `POST /triage` calls the graph with `config={"configurable": {"thread_id": ticket_id}}`, so every run's state is saved under the ticket's id and can be found again by it. This changes no response: the API output is identical to before. It prepares human-in-the-loop review, where a run will pause and later resume under that id. No interrupt or review node exists yet.
- **If startup cannot create the graph** it retries (3 attempts), then logs the error and boots anyway with `app.state.triage_graph = None`. `POST /triage` then returns `503` with `Retry-After`, and `/ready` returns `503` (reason `triage graph unavailable`) even if the database check passes. Restart the app once the database is reachable. `GET /tickets` and `/health` keep working.
- **`get_graph`** (`app/api/deps.py`) is the FastAPI dependency that hands the endpoint the graph. Tests replace it with a graph that uses an in-memory saver, through an autouse fixture in `tests/conftest.py`, so none of them needs Postgres. The real startup and the real checkpointer are covered by tests in `tests/integration/`.
- **Versions.** The AI libraries are on their current stable lines, all pinned exactly in `requirements.txt`: `langgraph 1.2.16`, `langgraph-checkpoint 4.3.0`, `langgraph-checkpoint-postgres 3.2.0`, `langgraph-prebuilt 1.1.1`, `langgraph-sdk 0.4.8`, `langchain-core 1.6.12`, `langchain-anthropic 1.7.6`, `anthropic 1.15.0`, `langsmith 0.14.11`, `psycopg-pool 3.3.3`. The umbrella `langchain` package is no longer installed: nothing imports it (only `langchain_core` and `langchain_anthropic`). Upgrading from the 0.2.x / 0.3.x line needed no change to the pipeline's behaviour: the request bodies sent to Claude were compared before and after and differ only in `max_tokens` (see gap #10).
- **Checkpoint serializer allowlist.** `app/graph/checkpointer.py` passes `JsonPlusSerializer(allowed_msgpack_modules=CHECKPOINT_TYPES)` to the saver. `CHECKPOINT_TYPES` names the app's own types that sit in the graph state (`TicketIn`, `ClassificationResult`, `KbMatch`, `Category`, `Urgency`). Without it the checkpoint library loads them with a "will be blocked in a future version" warning. With it, anything not listed is **blocked and comes back as a plain dict**, with only a log line, so a resumed run would fail with an obscure `AttributeError`. **When you add a type to `GraphState` (or to a model inside it), add it to `CHECKPOINT_TYPES`**; `tests/test_checkpointer.py` walks `GraphState` and fails if one is missing, and the tests' in-memory saver uses the same serializer.
- **Checkpoint tables are upgraded by the library on startup.** The new `langgraph-checkpoint-postgres` takes the checkpoint tables from its migration version 4 to 9 the first time `setup()` runs: one added column (`checkpoint_writes.task_path`, `NOT NULL DEFAULT ''`) and three indexes, nothing removed or changed. Until `setup()` has run, the new library cannot read the old tables at all (`column cw.task_path does not exist`). Checkpoints written by the old libraries, finished and paused, were read back and resumed correctly by the new ones. Rolling back to the old image afterwards should still work (the new column has a default), but that was not tested.
- **Entry point and tracing names.** The graph starts with `add_edge(START, "classify")`, not the older `set_entry_point`. LangSmith tracing uses the `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` names; the older `LANGCHAIN_*` names still work, but **if both sets are present and disagree, tracing is on when either says true**, so remove the old names from your `.env` instead of adding the new ones beside them.
- **Not done on purpose:** there is no retention policy yet. Every run writes checkpoint rows that nothing deletes.

## Tickets (`app/tickets/`)

Every successful triage is saved, so results can be read back and, later, paused for human review.

- **Table `tickets`** (created by migration 0001, extended by 0002; both run at startup, see "Database layer"): `id` (UUID, primary key), `reference` (text, NOT NULL, unique constraint `tickets_reference_key`), `status`, the original `subject`, `body` and `customer_id`, the triage result (`category`, `urgency`, `confidence`, `routing_target`, `suggested_reply`, `kb_sources` as JSONB, `needs_human_review`, `review_reason`), the review result (`final_reply`, `review_note`, `reviewed_at`, all nullable), and `created_at` / `updated_at`. Index on `(status, created_at)`.
- **Statuses.** `pending_review` when the result is flagged for human review, otherwise `triaged`. After a review: `approved`, `edited` or `rejected`. The column is plain text (no Postgres enum, no CHECK), so adding statuses needed no migration; the allowed values live in `TicketStatus` (`app/models.py`).
- **The reference** (`app/tickets/reference.py`): `TKT-` plus 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0`, `O`, `1`, `I`, `L`), drawn with `secrets`. 31^6 is about 887 million values. It is generated in `app/api/triage.py` next to `ticket_id`, before the graph runs, and is not part of the graph state. `save_ticket` returns the reference it stored: on a collision with the unique constraint it draws a new one and retries up to 3 more times (only for `tickets_reference_key`; any other integrity error, such as a duplicate id, propagates), and `triage.py` puts the returned value in the response so it always matches the row.
- **Migration 0002** adds `reference`, `final_reply`, `review_note` and `reviewed_at`. `reference` is added nullable, every existing row is given a unique one (a copy of the generator is inline in the migration, which imports no app code, and it draws again on a duplicate), then it is set NOT NULL and given the unique constraint. Downgrade drops the constraint and the four columns. A downgrade does **not** change statuses: a ticket already `approved`, `edited` or `rejected` keeps that text, which code from before 0002 would not accept. **The next time the real app starts, 0002 is applied to the real database** (migrations run at startup).
- **Store functions for reviews.** `get_ticket_by_reference(reference)`, and `record_review(session, ticket_id, decision, final_reply)`: one `UPDATE ... WHERE id = :id AND status = 'pending_review' RETURNING ...` that sets the new status, `final_reply`, `review_note`, `reviewed_at` and `updated_at`, and returns the record or `None` (unknown id, or not pending). That single compare-and-set is the database-level guard against two reviewers: whoever updates second matches no row. The caller owns the transaction. `record_review` is called by the review endpoint (see "The review endpoint"), after `resume_review` and inside the same transaction. `get_ticket_for_update(session, ticket_id)` is the locking read the endpoint uses first.
- **The ticket id is created before the graph runs** (`uuid4()` in `app/api/triage.py`) and is the graph run's `thread_id`, so a paused graph run can later be resumed by ticket id. `POST /triage` returns it as `ticket_id`.
- **When rows are saved.** After a successful graph run only, and low-confidence tickets are saved too. If the graph fails, nothing is saved.
- **Endpoints.** `GET /tickets?status=<triaged|pending_review|approved|edited|rejected>&limit=<1-200, default 50>` lists newest first. `GET /tickets/{ticket_id}` returns one ticket, 404 if missing, 422 for a malformed id. `POST /triage` and both GET responses include `reference`; the GET responses also include `final_reply`, `review_note` and `reviewed_at`. Adding `reference` to the `POST /triage` response is an additive API change.
- **A failed save returns 503.** A database that is unreachable (`sqlalchemy.exc.OperationalError`, or the driver's `psycopg.OperationalError` it wraps) gets a 503 with `Retry-After`, the same as LLM outages. Note that the triage work has already been done and paid for when the save fails, and the response is lost with it.
- **Shared database helper:** `app/db.py` (engine, session factory, `get_session`), used by both the KB and ticket stores.

## Human review pause (`app/graph/human_review.py`, `app/graph/review.py`)

- **What happens.** Both paths into the end of the graph go through `human_review`. Unflagged: it writes nothing. Flagged: `interrupt()` pauses the run, and `graph.invoke()` returns the state so far plus an `"__interrupt__"` entry. `POST /triage` builds its response from named keys only, so that entry never reaches the client, and a paused run is saved as `pending_review`. No endpoint, DB column or API contract changed.
- **Resume.** `review.is_paused(graph, ticket_id)` checks `get_state(...).next`. `review.resume_review(graph, ticket_id, ReviewDecision)` raises `ReviewNotPending` (before running anything) for an unknown, finished or already reviewed ticket, otherwise invokes `Command(resume=decision.model_dump())` and returns the final state. Verified on a real PostgresSaver across a simulated restart (new pool, saver and graph).
- **Re-run rule.** On resume LangGraph re-executes the whole `human_review` node. Nothing before `interrupt()` may have side effects. Tests count the `interrupt()` calls (1 at pause, 2 after resume) and check the classify, draft, critic and KB calls are not repeated.
- **The payload and decision are plain dicts**, so the checkpoint serializer allowlist needs no new entry.
- **Known gap: crash between pause and save.** If the app fails after the graph pauses but before `save_ticket`, a paused thread exists with no ticket row, and the client gets a 503. A retry creates a new ticket id, so the orphan thread is never found.
- **Known limitation (LangGraph 1.2.16): a bad raw resume strands the ticket.** If `graph.invoke(Command(resume=<invalid>))` is called directly, the node raises `ValueError("Invalid review decision: ...")` and the ticket stays paused, but the invalid value is saved as the task's pending write and replayed on every later resume, so even a valid decision then fails. Measured on MemorySaver and on PostgresSaver, in the same process and after a restart. `resume_review` avoids this because it only accepts a validated `ReviewDecision`. Pinned by a strict `xfail` test. A possible fix (not done, it changes the "raise a clear ValueError" rule): make the node loop and call `interrupt()` again on invalid input.
- **Other resume quirks seen:** `Command(resume=None)` raises an internal `UnboundLocalError`, and `Command(resume={})` is a silent no-op (the ticket stays paused). A dict whose keys are not interrupt-id digests is treated as one resume value.
- **Two reviewers at once** is now handled and tested, one level up, by the review endpoint's row lock (see "The review endpoint").

## The review endpoint (`app/api/review.py`, `app/api/auth.py`)

`POST /tickets/{ticket_id}/review`, body `ReviewDecision`, response `TicketRecord`.

- **Auth** (`require_review_key`): the `X-API-Key` header is compared with `REVIEW_API_KEY` using `secrets.compare_digest` on bytes. An empty setting means the endpoint is disabled (503, whatever header is sent); a missing or wrong key is 401. The setting is read on every request. The key is checked before anything else, including body validation and the graph lookup, so an unauthenticated caller gets 401 even for a malformed body.
- **The flow**, all inside one `with get_session()` (which commits when the block ends normally and rolls back on any exception, `HTTPException` included): (a) `get_ticket_for_update` reads the row with `SELECT ... FOR UPDATE`, which locks it until the transaction ends; unknown id is 404. (b) status other than `pending_review` is 409. (c) `resume_review(graph, ticket_id, decision)`; `ReviewNotPending` is 409 and `ReviewNotAllowed` is 422. (d) `record_review(...)`, the compare-and-set UPDATE; `None` is 409. (e) return the updated record; the commit happens as the block exits.
- **The lock** makes two simultaneous reviews of one ticket safe: the second request waits at (a), and when the first commits it sees `approved` and answers 409 without touching the graph. The compare-and-set in (d) is a second line of defence. The concurrency tests prove the lock matters: with `with_for_update()` removed, both requests got into `resume_review`.
- **Only a validated `ReviewDecision` is passed to `resume_review`**, because FastAPI validates the body first (422 otherwise). A raw invalid resume value would strand the ticket (see "Human review pause").
- **Approve needs a draft.** `resume_review` raises `ReviewNotAllowed` when the action is `approve` and the paused state has no `draft_reply` (low-confidence tickets skip drafting). Edit and reject work without one. This replaced the M2.7b behaviour where such an approve produced `final_reply = None`.
- **`GET /tickets/reference/{reference}`** lives in the same file. It has two path segments, so `/tickets/{ticket_id}` (one segment) can never capture it. Unknown reference is 404.
- **Known gaps.**
  1. *Graph and row are not one transaction.* If the graph resumes (step c) and the commit (or step d) then fails, the rollback restores the row to `pending_review` but the graph run has already finished and cannot be paused again. The row then says `pending_review` for a run that is no longer paused, and a retry gets 409. Fixing it needs a reconcile step or a different order (record first, resume after), neither of which is built.
  2. *Reads are unauthenticated.* `GET /tickets`, `GET /tickets/{id}` and `GET /tickets/reference/{reference}` need no key and return the customer's subject and body.
  3. *No reviewer identity is recorded.* Only the optional `note` is stored.
  4. *One shared API key,* no rotation, no per-reviewer revocation, no rate limit.
  5. *The lock is held while the graph runs.* Fine at this scale; a slow graph step keeps a row locked and a database connection busy.

## Gaps and things to consider

### 1. Wasted LLM call on low-confidence tickets (RESOLVED)
Previously the reply was drafted before the critic checked confidence, so a low-confidence ticket paid for a draft that was then flagged anyway. Resolved by a conditional edge after `route`: tickets under the threshold go to `flag_low_confidence` and make no KB, draft or critic calls.

### 2. `.get()` fallbacks in `triage_ticket` cannot trigger
The graph is linear and every path sets `routing_target`, `kb_context`, `draft_reply`, `needs_human_review` and `review_reason`. The defaults (`"general-queue"`, `[]`, `True`, ...) are harmless but would hide a bug if a node stopped writing a field. Consider `final_state["..."]` so a missing field fails loudly.

### 3. Nodes return the full state
Each node returns `{**state, "key": value}`. LangGraph only needs the changed keys, so `{"key": value}` is enough. The spread can cause update conflicts if parallel branches are added later (for example, running `route` and `retrieve_kb` in parallel).

### 4. Sequential LLM latency
A request makes up to three sequential LLM calls (classify, draft, critique), so per-request latency adds up. The blocking `invoke` is not a problem: the endpoint is a plain `def`, which FastAPI runs in a threadpool.

### 5. Model ID (RESOLVED)
The model is the setting `model_id` (`MODEL_ID`, default `claude-sonnet-4-6`) in `app/config.py`, read by all three LLM calls, so it is defined in one place. Confirm `claude-sonnet-4-6` is the model you intend to run.

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

### 10. Replies longer than the token cap are cut off (MITIGATED: flagged, not prevented)
Every Claude call (classifier, drafter, critic) sends an explicit `max_tokens` from the setting `llm_max_tokens` (`LLM_MAX_TOKENS`, default 700, about 500 words, must be greater than 0). It is set explicitly because `langchain-anthropic`'s own default differs between versions: 1024 in 0.2.x, and the model's maximum (128000 for `claude-sonnet-4-6`) in 1.x. Without a pinned value, upgrading the library would have silently removed the cap. The request bodies were compared on both library versions and only this field differed. 700 is lower than the earlier effective 1024, a deliberate choice.

**What happens when a call hits the cap.**
- **Drafter (the case that used to be silent).** The reply stops mid-sentence. Claude's stop reason is `max_tokens`, and `draft_reply` now keeps it instead of discarding it with the parser: it returns `draft_truncated: true` next to `draft_reply`, and logs a warning with the token count (a finished draft logs an info line with its token count). The critic has a rule-based check for `draft_truncated`: it flags the ticket for human review with the reason "Draft reply was cut off at the token limit." and does not spend an LLM call. The cut-off text is still returned as `suggested_reply`, so a reviewer can see it. If the KB also failed or had no match, the reasons are joined.
- **Classifier and critic.** A cut-off structured answer is missing required fields, so the output parser raises a validation error and the request becomes a `500` (LangChain also logs "Output parser received a `max_tokens` stop reason"). This is loud, not silent, and unlikely at these output sizes, since the structured results are far smaller than the cap. It is not handled specially.

**Verified** on both library versions (0.2.3 and 1.7.6) with the real chains against a fake local Anthropic server that reports `max_tokens`: the ticket is flagged and only the drafter's request is sent. **Not done:** nothing makes cut-offs rarer, and how often they happen on real tickets is unknown. Once real tickets have run, the logged token counts show whether to raise the cap (possibly for the drafter alone) or ask the drafter prompt for shorter replies.

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