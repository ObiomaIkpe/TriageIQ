# TriageIQ Roadmap: from prototype to production-grade

Goal: a portfolio project that holds up to scrutiny as a real system. Every item is a deliverable with a concrete "done when" test. `[x]` = already in the repo, `[ ]` = to do. *(partly done: ...)* marks an item that is started but not finished, and says what is missing.

Baseline already in place:
- [x] LangGraph pipeline: classify -> route -> retrieve_kb -> draft_reply_node -> critique
- [x] FastAPI endpoint `POST /triage` and `GET /health`
- [x] Structured output via `with_structured_output` (classifier, critic)
- [x] Critic receives KB context and flags without an LLM call when the KB failed, had no match, or the draft was cut off; low-confidence tickets skip it through a conditional edge
- [x] pgvector KB with Voyage embeddings, Docker Compose stack
- [x] Cosine-distance cutoff (0.5) chosen from measured distances (verified end to end on 2026-10-05; the value itself is still provisional, see B7)
- [x] `NOTES.md` documenting how it works and known gaps
- [x] Ticket persistence (`tickets` table) with `GET /tickets` and `GET /tickets/{id}`; the ticket id is created before the graph runs
- [x] SQLAlchemy 2.0 data layer with Alembic migrations applied at startup, and tests against a real Postgres (`TEST_DATABASE_URL`)
- [x] Postgres checkpointer: the graph is built at startup and every run carries `thread_id` = ticket id (the groundwork for A9)
- [x] Explicit `LLM_MAX_TOKENS` cap, with drafts cut off at the cap flagged for human review
- [x] LangChain and LangGraph on current stable versions, with a checkpoint serializer allowlist
- [x] A `human_review` pause in the graph, with `resume_review()` helpers (M2.7b)
- [x] Review endpoint `POST /tickets/{id}/review` (M2.8b): API-key check, row lock so two reviewers cannot both win, approve refused when there is no draft, plus `GET /tickets/reference/{reference}`
- [x] Database support for human review (M2.8a): migration 0002 (`reference`, `final_reply`, `review_note`, `reviewed_at`), the `approved`/`edited`/`rejected` statuses, a short ticket reference in the API, and the store functions `get_ticket_by_reference` and `record_review`

---

## A. Agent capabilities

- [ ] **A1. Revise loop.** When the critic flags a fixable problem, feed its feedback back to the drafter and retry, max 2 revisions, then escalate to human. New state fields: `revision_count`, `critic_feedback`. Conditional edges `critique -> draft_reply_node | END`. *Done when:* the eval set (G) shows fewer flagged replies with the loop than without, and the loop provably terminates.
- [ ] **A2. Customer-context tool.** `TicketIn.customer_id` is currently unused. Add a `customers` table (plan, signup date, open tickets, past ticket count) and a lookup node whose output feeds classification, urgency, and the reply. *Done when:* an enterprise customer's ticket gets different urgency than an identical free-tier ticket, with a test proving it.
- [ ] **A3. Real branching.** Replace the straight line with branches:
  - [ ] spam/abuse detection -> drop or low-priority path
  - [ ] duplicate detection (embedding similarity against recent open tickets) -> link instead of re-triage
  - [ ] auto-resolve path: high confidence + strong KB match -> reply marked ready to send
  - [ ] immediate-escalation path: outage, security, legal, or data-loss language -> skip drafting, page a human
  - [x] skip drafting when classifier confidence < threshold (the `flag_low_confidence` branch makes no KB, draft or critic calls)
- [ ] **A4. Richer ticket understanding.**
  - [ ] multi-intent: list of categories with a primary one
  - [ ] language detection, with reply in the customer's language
  - [ ] sentiment/frustration score feeding urgency
  - [ ] entity extraction (order ID, product, error code)
  - [ ] one-paragraph summary for human agents
- [ ] **A5. Taxonomy v2.** Add categories for shipping/hardware, feature request, security, abuse; add subcategories; per-field confidence. Resolves the "broken laptop refund" ambiguity found in testing. *(partly done: `shipping` added; the other categories, subcategories and per-field confidence are not)*
- [ ] **A6. Parallel execution.** Run `route` and `retrieve_kb` concurrently (return only state deltas, see I3). *Done when:* measured p50 latency drops and a test shows no state conflicts.
- [ ] **A7. Reply guardrails.** Deterministic checks before the LLM critic: no refund/credit/ETA promises unless present in KB, banned phrases, length limit, required signature, no URLs outside an allowlist. Replies cite the KB articles they used.
- [ ] **A8. Confidence calibration.** The classifier's 0.97 is self-reported by the model and not calibrated. Combine classifier confidence, retrieval distance, and critic verdict into one calibrated score using the eval set; show a reliability diagram; choose the review threshold by cost of a missed vs unnecessary review.
- [ ] **A9. Human-in-the-loop as a first-class step.** Use a LangGraph checkpointer and `interrupt` so a flagged ticket pauses, a human approves/edits/rejects, and the graph resumes. Capture the edit as feedback (see G9). *(partly done: the checkpointer and `thread_id` = ticket id exist, and as of M2.7b a `human_review` node pauses flagged tickets with `interrupt()` and `app/graph/review.py` can approve, edit or reject them, tested across a restart on Postgres. As of M2.8a the database side exists, and as of M2.8b `POST /tickets/{id}/review` resumes the run and records the decision under a row lock. Still missing: feedback capture (G9), the stranding fix for bad raw resumes, reviewer identity and per-reviewer keys, authenticated reads, and closing the gap where the graph resumes but the final commit fails)*
- [ ] **A10. Conversation threads.** Handle follow-ups and reopened tickets using prior messages as context.

## B. Retrieval and knowledge base

- [ ] **B1. Return article `topic` and ID** with each snippet; surface them in `kb_sources` and in the reply citations. *(partly done: `topic` is returned; the article ID is not, and replies do not cite sources)*
- [ ] **B2. Hybrid search** (keyword/BM25 + vector) with reciprocal-rank fusion.
- [ ] **B3. Reranker** (Voyage rerank) over the top ~20 candidates before the cutoff.
- [ ] **B4. Query rewriting.** Condense subject + body into a focused query instead of embedding raw text.
- [ ] **B5. Chunking** for long articles, with overlap and parent-article IDs.
- [ ] **B6. Metadata filters** (category, product, language, audience) applied in SQL.
- [ ] **B7. Cutoff tuned on data.** *(M5.2a loosened the cutoff to 0.65 and added a Claude relevance grader, `grade_kb`; neither has been measured with real calls yet)* Replace the provisional 0.5 with a value chosen by precision/recall on labelled retrieval cases; "no-answer" detection reported as its own metric.
- [ ] **B8. KB management.** CRUD (CLI and authenticated endpoints), idempotent upsert with a unique key, content hash to skip re-embedding, article versions, source URLs. *(partly done: ingest is an idempotent upsert on a unique `topic`; no CRUD, content hash, versions or source URLs)*
- [ ] **B9. Embedding versioning.** Store model name/version per row, plus a re-embed migration script, so a model change cannot silently corrupt search.
- [ ] **B10. Vector index** (HNSW) once the KB exceeds a few hundred articles; benchmark before/after.
- [ ] **B11. Realistic KB content:** 50+ real-style articles, not 5 samples.

## C. Reliability and resilience

- [ ] **C1. Timeouts** on every external call (Anthropic, Voyage, Postgres) plus an overall request deadline. *(partly done: Claude calls and the checkpointer pool have timeouts; Voyage, Postgres statements and an overall request deadline do not)*
- [ ] **C2. Retries** with exponential backoff and jitter on 429/5xx; respect `Retry-After`. *(partly done: Claude via the SDK's `max_retries`, Voyage via its own backoff; no jitter, and `Retry-After` is not honoured explicitly)*
- [ ] **C3. Graceful degradation matrix**, documented and tested per node (partly done: only the retrieval-failure case; a failed draft or critic still ends in an error):
  - retrieval fails -> continue with empty context, flag for review
  - draft fails -> return classification + routing + `needs_human_review: true`
  - critic fails -> flag for review
  - classify fails -> structured error response
- [ ] **C4. Structured-output failure handling:** retry on validation errors, then fall back to human review.
- [ ] **C5. Model fallback** and a circuit breaker for provider outages.
- [x] **C6. Client-side rate limiter** (token bucket) for Voyage; resolves the 3 requests-per-minute free-tier problem or documents the paid-tier requirement. (a sliding-window limiter driven by `VOYAGE_RPM`)
- [x] **C7. Caching:** LRU/Redis for query embeddings; optional response cache for identical tickets. (query-embedding LRU only; no response cache)
- [x] **C8. Connection pooling** (`psycopg_pool`) instead of a new connection and `CREATE EXTENSION` on every call. (the SQLAlchemy engine pools connections, and `CREATE EXTENSION` now runs only in the migration)
- [x] **C9. Schema at startup** via migrations (Alembic), not a manual ingest side effect. `/health` and a separate `/ready` that checks the database. (Alembic at startup; `/ready` checks the database and the graph)
- [ ] **C10. Idempotency keys** on `POST /triage` so client retries don't duplicate work or cost.
- [ ] **C11. Graceful shutdown** and in-flight request handling. *(partly done: the checkpointer pool is closed at shutdown)*
- [ ] **C12. Typed error responses** with stable error codes.

## D. Scale and async processing

- [ ] **D1. Queue + workers** (Celery/RQ/Arq): `POST /triage` returns `202` with a ticket ID; `GET /triage/{id}` returns status/result.
- [ ] **D2. Signed webhooks** for completion, with retries.
- [ ] **D3. Batch endpoint** for bulk triage.
- [ ] **D4. Streaming progress** (SSE) per node.
- [ ] **D5. Stateless app containers**, horizontally scalable; documented.
- [ ] **D6. Load test** (k6/Locust) with published results: throughput, p95 latency, error rate, cost per 1,000 tickets.

## E. Security and privacy

- [ ] **E1. Authentication:** API keys stored hashed, with rotation and scopes.
- [ ] **E2. Rate limiting** per key, and input limits (subject/body length, request size).
- [ ] **E3. Prompt-injection defenses:** mark ticket text as untrusted in all three prompts, instruction hierarchy, delimiter and escaping strategy, output validation, and treat the critic as a second layer, not the only one (gap #6).
- [ ] **E4. Adversarial test suite:** injection ("ignore your instructions"), jailbreak, data exfiltration of the system prompt, role confusion, oversized and malformed inputs. Run in CI.
- [ ] **E5. PII handling:** detect and redact personal data before it reaches LLM calls and logs; documented retention; a delete-by-customer endpoint.
- [ ] **E6. Secrets management:** no `.env` baked into images, Docker/secret-manager integration, `gitleaks` scan across full history. *(partly done: `.env` is git-ignored and `.dockerignore` keeps it out of the image; no secret-manager integration or history scan)*
- [ ] **E7. Dependency and image scanning** (pip-audit, Dependabot, Trivy); pinned lockfile.
- [ ] **E8. Container hardening:** multi-stage build, non-root user, read-only filesystem, healthcheck.
- [ ] **E9. HTTP hardening:** CORS policy, security headers, TLS termination documented.
- [ ] **E10. Audit log** of who triaged, reviewed, and edited what.
- [ ] **E11. Threat model document** (STRIDE) covering prompt injection, data leakage, abuse of cost, and tenant isolation.

## F. Data and persistence

- [ ] **F1. Tables:** `tickets`, `triage_results`, `reviews`, `feedback`, `audit_events`, `prompt_versions`; Alembic migrations. *(partly done: `tickets` and its Alembic migration exist; the other tables do not)*
- [ ] **F2. Store per result:** raw ticket, outputs, model IDs, prompt version, node latencies, token counts, cost. *(partly done: the raw ticket and the outputs are stored; model IDs, prompt version, latencies, token counts and cost are not)*
- [ ] **F3. API:** `POST /triage` returns `201` with an ID; `GET /triage/{id}`; list and filter; review-queue endpoints. *(partly done: `GET /tickets/{id}` and `GET /tickets` with a status filter exist; `POST /triage` still returns 200 and there are no review-queue endpoints)*
- [ ] **F4. Retention jobs** and a documented backup/restore procedure.
- [x] **F5. Indexes** for the access patterns above.

## G. Evaluation and quality

- [ ] **G1. Labelled dataset, 100+ tickets,** *(started: 20 tickets in `evals/dataset/tickets_v1.jsonl`)* stratified: every category and urgency, ambiguous cases, multi-intent, multilingual, empty-KB cases, adversarial inputs.
- [ ] **G2. Eval harness** (`python -m evals.run_eval`) that outputs a report with: *(started: M5.1 built the runner and deterministic scoring for category, urgency, flag, retrieved topic and phrase checks; the items below are still open)*
  - [ ] category accuracy, macro-F1, confusion matrix
  - [ ] urgency accuracy with ordinal error
  - [ ] routing correctness
  - [ ] retrieval recall@k and precision at the cutoff
  - [ ] reply groundedness/faithfulness (LLM judge plus human spot-check)
  - [ ] critic precision/recall on deliberately bad drafts
  - [ ] calibration error
  - [ ] latency p50/p95 and cost per ticket
- [ ] **G3. CI regression gate:** fail the build if any metric drops below a stored baseline.
- [ ] **G4. Threshold tuning** for confidence (0.6) and distance (0.5) using precision/recall curves, with the chosen values and reasoning recorded.
- [ ] **G5. Prompt versioning and A/B comparison** run through the same eval set.
- [ ] **G6. Labelling guide** and an agreement check on a subset.
- [ ] **G7. Drift monitoring** on sampled production tickets (category mix, review rate, empty-context rate).
- [ ] **G8. Variance check:** repeat runs on the same tickets to measure nondeterminism.
- [ ] **G9. Feedback loop:** human corrections feed back into the eval set.

## H. Testing and CI/CD

- [x] **H1. Unit tests:** `route` (including the `-urgent` suffix and fallback), critic shortcut, context formatting, cutoff SQL.
- [x] **H2. Integration tests** with a real pgvector container (testcontainers). (the compose Postgres via `TEST_DATABASE_URL`, not testcontainers)
- [ ] **H3. Graph tests** with fake LLMs (deterministic) and recorded cassettes. *(partly done: fake LLMs yes, recorded cassettes no)*
- [ ] **H4. API tests** with FastAPI `TestClient`, including validation errors (422), auth, and rate limits. *(partly done: validation errors and the 503 paths are tested; auth and rate limits do not exist yet)*
- [x] **H5. Contract tests** pinning the response schema. (the exact-JSON response tests)
- [ ] **H6. Property-based tests** (Hypothesis) for routing and input handling.
- [ ] **H7. Coverage target** with report.
- [ ] **H8. GitHub Actions:** ruff, formatting, mypy/pyright, tests, image build, Trivy scan, eval gate, badges.
- [ ] **H9. Pre-commit hooks,** `Makefile` for common tasks.
- [ ] **H10. CD:** deploy to a hosted platform with dev/staging/prod environments, migrations on deploy, rollback documented.

## I. Code quality and configuration

- [ ] **I1. Typed settings** for everything tunable: model IDs, temperatures, `MAX_DISTANCE`, confidence threshold, `top_k`, timeouts. No model ID repeated across files (gap #5). *(partly done: model ID, timeouts, retries, `max_tokens` and the confidence threshold are settings; the temperatures, `MAX_DISTANCE` and `top_k` are still constants)*
- [ ] **I2. Prompts in versioned template files,** not inline strings.
- [x] **I3. Nodes return only state deltas,** not `{**state, ...}` (gap #3).
- [x] **I4. Replace silent `.get()` defaults** in `triage_ticket` with explicit access so a missing field fails loudly (gap #2). (the two optional lookups, `draft_reply` and `kb_context`, are documented as optional)
- [ ] **I5. Strict typing** (mypy) and consistent logging; no stray prints.
- [x] **I6. Config cleanup:** remove duplicate lowercase env var, complete `.env.example`. (the duplicate lowercase name is gone and `.env.example` lists every setting; tests guard both)
- [ ] **I7. Architecture Decision Records** for: deterministic router vs LLM, critic design, cutoff approach, structured output, queue choice.
- [ ] **I8. Routing rules as data** (YAML/DB), not a hardcoded dict.

## J. Observability

- [ ] **J1. Structured JSON logs** with request/trace IDs; PII scrubbed.
- [ ] **J2. LLM tracing** (LangSmith or Langfuse) enabled with a valid key, or tracing flag turned off to stop warnings.
- [ ] **J3. OpenTelemetry** traces across API, graph nodes, Voyage, and Postgres.
- [ ] **J4. Metrics endpoint** (`/metrics`): per-node latency, error rates, token usage, cost, review rate, empty-context rate, cutoff hit rate.
- [ ] **J5. Dashboard** (Grafana JSON committed).
- [ ] **J6. Alerts:** error rate, p95 latency, review-rate drift, cost budget, provider 429s.
- [ ] **J7. Per-request cost tracking** exposed in the response metadata and stored.

## K. Product and integrations

- [ ] **K1. Helpdesk integration adapter** (Zendesk/Freshdesk/email/Slack webhook) that acts on `routing_target`.
- [ ] **K2. Reviewer UI:** queue of flagged tickets, side-by-side ticket and draft, edit/approve/reject.
- [ ] **K3. Analytics dashboard:** volume, category mix, review rate, latency, deflection rate.
- [ ] **K4. SLA timers** and auto-escalation by urgency.
- [ ] **K5. Multi-tenancy:** `tenant_id`, per-tenant KB and routing rules, isolation tests.
- [ ] **K6. Email ingestion** and attachment handling.

## L. Documentation and presentation

- [ ] **L1. README:** what and why, architecture diagram, 3-command quickstart, example request/response, results table from G2. *(partly done: everything except the results table from G2)*
- [x] **L2. Diagrams** (Mermaid): the graph with its branches, and the deployment layout. (the pipeline graph and a components diagram, in the README)
- [ ] **L3. Evaluation report** with real numbers and methodology.
- [ ] **L4. API documentation:** OpenAPI descriptions and examples for every endpoint.
- [ ] **L5. Runbook:** deploy, rotate keys, re-embed, handle provider outage, restore backup.
- [x] **L6. Known limitations** section (start from `NOTES.md`). (the README's Status and limitations section)
- [ ] **L7. Live demo** deployed, plus a short recorded walkthrough.
- [ ] **L8. Case-study write-up:** problem, design choices, what the evaluation showed, what you would do next.
- [ ] **L9. Repo hygiene:** LICENSE, CONTRIBUTING, changelog, tagged releases, clean history.

---

## Suggested order

1. **M1: correctness.** Verify the cutoff; H1-H5; C1-C4; C9. (Tests, failure handling, schema at startup.)
2. **M2: safety.** E1-E4, E6, E8; C6, C8; I1, I3, I4.
3. **M3: data and visibility.** F1-F3; J1, J2, J4; D1.
4. **M4: agent depth.** A1, A2, A3, A5, A7; B1-B4.
5. **M5: proof.** G1-G4; A8; H8; L1-L3.
6. **M6: polish and ship.** H10, K1-K2, L4-L9, J5-J6, remaining items.

Build the evaluation set (G1) early, even if small, because every later change should be measured against it.
