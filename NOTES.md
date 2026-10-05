# TriageIQ: How It Works and Open Gaps

Notes from a walkthrough of the code. Changes made since: the classifier and critic now use `with_structured_output`, and the critic now receives the KB context (see "Resolved" and "Test results" below).

## How it works

A request to the triage endpoint runs a LangGraph workflow (`app/graph/build.py`):

```
classify -> route -> retrieve_kb -> draft_reply_node -> critique -> END
```

The graph is linear, with no branches. `triage_ticket` (`app/api/triage.py`) builds the initial state `{"ticket": ticket}`, calls `triage_graph.invoke(...)`, and maps the final state to a `TriageResult`.

`GraphState` (`app/models.py`) is a `TypedDict` with `total=False`, so the state can start with only `ticket`. Each node adds its own fields.

| Node | File | Writes | Notes |
|---|---|---|---|
| `classify` | `graph/classifier.py` | `classification` | LLM, temperature 0, `with_structured_output(ClassificationResult)` |
| `route` | `graph/router.py` | `routing_target` | No LLM. Map lookup by category, plus `-urgent` suffix for high/critical |
| `retrieve_kb` | `graph/kb_retrieval.py` | `kb_context` | Vector search, top 3 matches on subject + body |
| `draft_reply_node` | `graph/reply_draft.py` | `draft_reply` | LLM, temperature 0.3, grounded in `kb_context` |
| `critique` | `graph/critic.py` | `needs_human_review`, `review_reason` | Confidence < 0.6 flags without an LLM call. Otherwise an LLM reviews the draft against the ticket, classification and `kb_context` |

The node is named `draft_reply_node` because LangGraph does not allow a node name to match a state key (`draft_reply`).

## Knowledge base (`app/kb/`)

The `retrieve_kb` node finds the 3 KB articles closest in meaning to the ticket, using semantic search.

- **Embedding (`store.py: embed_text`).** Text is sent to Voyage AI (`voyage-3`), which returns 1024 numbers. `input_type` is `"document"` when storing articles and `"query"` when searching, because Voyage tunes the embeddings differently for each.
- **Storage.** Articles live in Postgres, table `kb_documents` (`id`, `topic`, `content`, `embedding VECTOR(1024)`), using the `pgvector` extension.
- **Search (`search_similar`).** `ORDER BY embedding <=> query_embedding LIMIT 3` (cosine distance). It returns a plain `list[str]` of article contents.
- **Seeding (`ingest.py`).** A one-off script, run with `python -m app.kb.ingest`. It creates the table, then embeds and inserts 5 sample FAQ documents (password reset, billing cycle, account lockout, subscription cancellation, two-factor authentication). It sleeps 20 seconds between documents to stay under the Voyage free-tier limit of 3 requests per minute.
- **Empty table.** If no articles exist, search returns `[]` and the drafter says a specialist will follow up.

## Gaps and things to consider

### 1. Wasted LLM call on low-confidence tickets
The reply is drafted before the critic checks confidence. If confidence is below 0.6, the draft call is made and then flagged anyway. A conditional edge after `classify` could skip drafting for those tickets.

### 2. `.get()` fallbacks in `triage_ticket` cannot trigger
The graph is linear and every path sets `routing_target`, `kb_context`, `draft_reply`, `needs_human_review` and `review_reason`. The defaults (`"general-queue"`, `[]`, `True`, ...) are harmless but would hide a bug if a node stopped writing a field. Consider `final_state["..."]` so a missing field fails loudly.

### 3. Nodes return the full state
Each node returns `{**state, "key": value}`. LangGraph only needs the changed keys, so `{"key": value}` is enough. The spread can cause update conflicts if parallel branches are added later (for example, running `route` and `retrieve_kb` in parallel).

### 4. Blocking `invoke` and sequential LLM latency
`invoke` is synchronous. The endpoint is a plain `def`, which FastAPI runs in a threadpool, so this does not block the event loop today. It would only become a problem if the endpoint were changed to `async def` without switching to `await triage_graph.ainvoke(...)`. A request still makes up to three sequential LLM calls (classify, draft, critique), so per-request latency adds up.

### 5. Model ID
All three LLM calls use `claude-sonnet-4-6`. Confirm this is the intended model, and consider moving it to one config constant instead of repeating it in three files.

### 6. Prompt injection
Ticket text goes straight into the classifier, drafter and critic prompts, and the draft is fed to the critic. A hostile ticket could try to steer the classification or the review verdict. The human-review flag helps, but the critic is itself an LLM reading attacker-influenced text.

### 7. Critic `reason` can be empty
`CritiqueResult.reason` is an empty string when no review is needed. `triage_ticket` handles that with `review_reason or None`. The low-confidence shortcut uses a fixed string, `"Low classifier confidence."`.

### 8. Knowledge base gaps
- **Voyage rate limit at request time.** `ingest.py` sleeps 20 seconds between documents because of a 3 requests-per-minute free-tier limit. But every triage request also makes one Voyage embedding call in `search_similar`. On the free tier, the endpoint would hit the limit after about 3 requests in a minute. Not tested; this follows from the limit stated in the `ingest.py` comment.
- **No similarity cutoff.** Search always returns 3 results, even when none are relevant. A ticket the KB doesn't cover still gets the 3 least-bad articles, which can mislead the drafter.
- **`topic` is never returned.** `search_similar` selects only `content`, so the drafter and the API's `kb_sources` can't show which article a snippet came from.
- **New database connection on every call.** `get_connection()` opens one each time and also runs `CREATE EXTENSION IF NOT EXISTS vector`. Fine at low traffic; a connection pool is the usual fix.
- **Ingest is not idempotent.** `kb_documents` has no unique constraint on `topic`, so running `python -m app.kb.ingest` twice inserts every document twice, and duplicates can fill the top 3 results.
- **Extra latency.** Each retrieval is a Voyage API call plus a Postgres query, even though no LLM is involved.
- **Config required.** `voyage_api_key` and `database_url` come from `app/config.py`; the app won't start without them.

### 9. Not yet checked
- Error handling: if any node or LLM call raises, `invoke` raises and the endpoint returns a 500. There are no retries or fallbacks.
- Whether the endpoint should return 200 or 201 depends on whether a triage record is persisted. Currently it only computes a result, so 200 is correct.

## Resolved

### Critic could not see the KB
The critic's prompt told it to flag claims "not supported by the knowledge base context", but `critique` never passed it the KB articles. It could not verify anything, so it flagged replies that were fully supported by the KB. Fixed in `app/graph/critic.py`: `kb_context` is now formatted (same fallback text as `draft_reply.py`) and included in the critic's prompt.

## Test results

Run against the rebuilt Docker stack with real Anthropic and Voyage calls.

1. **"Cannot log in" / forgot password** (a KB article covers it). Classified account / low / 0.97, routed to `account-management`. The reply was grounded in the KB. Before the critic fix it was flagged for review with the reason that no KB was provided. After the fix: `needs_human_review: false`, `review_reason: null`.
2. **"Hardware refund"** (no KB article covers it). Classified billing / high / 0.82, routed to `billing-team-urgent`. The drafter said it did not have the policy and escalated to a specialist rather than inventing one. The critic flagged it for review, noting that the KB has nothing on hardware refunds and that the category is questionable.

Together these show the critic clears supported replies and still flags unsupported ones.

### Findings from the tests
- **No similarity cutoff, seen in practice (gap #8).** Test 1 got lockout and 2FA paragraphs the customer did not ask about. Test 2 got 3 articles, none relevant.
- **Category design.** A broken-hardware refund request has no obvious category among billing / technical / account / other. The classifier chose billing and the critic questioned it. This is a category design question, not a code bug.
- **Content gap.** The KB has no hardware refund article, so tickets like test 2 will always need a human until one is added.
- **Test coverage.** Only two tickets were tried, and only one run each. This is a sanity check, not a measurement of reliability.

## Answers to earlier questions

- Blocking: this is a plain def, not async def. FastAPI runs plain def endpoints in a threadpool, so the blocking invoke does not freeze the event loop. Gap #4 in NOTES.md is therefore a non-issue for the current code. It only applies if someone changes this to async def without switching to ainvoke. I'll correct that note.
- Status code: the endpoint uses the default 200, which is correct since nothing is persisted.
- Unused import: GraphState is used for the annotation on line 11, so that import is fine.
