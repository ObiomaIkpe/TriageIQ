import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError

from app import usage as usage_tracking
from app.api.deps import get_graph
from app.models import GraphState, TicketIn, TriageResult
from app.tickets.reference import new_reference
from app.tickets.store import (
    attach_usage,
    get_ticket,
    is_reference_collision,
    is_ticket_id_collision,
    save_ticket,
    ticket_lock,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/triage", tags=["triage"])

# Keys every finished or paused run has written. A checkpoint missing one of them is not
# trusted: the run is started again instead of failing on a lookup.
_RESULT_KEYS = ("classification", "routing_target", "needs_human_review", "review_reason")
# The node a flagged ticket pauses in (see app/graph/human_review.py).
_REVIEW_NODE = "human_review"


def _build_result(final_state: dict, ticket_id: str, reference: str) -> TriageResult:
    # Strict lookups on purpose: every node must write its fields, and a
    # missing one should fail loudly (500) instead of silently defaulting.
    classification = final_state["classification"]

    return TriageResult(
        ticket_id=ticket_id,
        reference=reference,
        category=classification.category,
        urgency=classification.urgency,
        confidence=classification.confidence,
        routing_target=final_state["routing_target"],
        # Optional on purpose: low-confidence tickets skip retrieval and
        # drafting, so these two keys are legitimately absent for them.
        suggested_reply=final_state.get("draft_reply"),
        kb_sources=final_state.get("kb_context", []),
        needs_human_review=final_state["needs_human_review"],
        review_reason=final_state["review_reason"] or None,
    )


# The code a caller can rely on when a reference it chose already belongs to another ticket.
REFERENCE_CONFLICT = "reference_conflict"


def _reference_for(ticket: TicketIn) -> str:
    """The reference the gateway chose, else a new one made here (as before)."""
    return ticket.reference or new_reference()


def _save(ticket: TicketIn, result: TriageResult) -> TriageResult:
    """Save the row and return the result with the reference that was stored.

    save_ticket returns the reference it stored: after a collision it is a new one,
    and the response must match the row. A reference the caller chose is never changed:
    a collision on it is a 409 with the code reference_conflict (the gateway's worker
    treats that as unrecoverable, because retrying cannot fix it).
    """
    chosen = ticket.reference is not None
    try:
        if chosen:
            stored_reference = save_ticket(ticket, result, regenerate_reference_on_collision=False)
        else:
            stored_reference = save_ticket(ticket, result)
    except IntegrityError as exc:
        if chosen and is_reference_collision(exc):
            logger.error("reference_conflict: a supplied reference belongs to a different ticket")
            raise HTTPException(
                status_code=409,
                detail={"code": REFERENCE_CONFLICT, "message": "reference already used by another ticket"},
            ) from exc
        raise
    return result.model_copy(update={"reference": stored_reference})


def _graph_ticket(ticket: TicketIn) -> TicketIn:
    """The ticket as the graph (and so the model and the checkpoint) may see it.

    The customer's name and email are for the reviewer only: they are removed here so they can
    never reach a prompt or be stored in the graph state. The reference is bookkeeping, not content.
    """
    return ticket.model_copy(update={"customer_name": None, "customer_email": None, "reference": None, "is_demo": False})


def _run_graph(ticket: TicketIn, ticket_id: str, graph) -> dict:
    # The id exists before the graph runs, and is the run's thread id, so a
    # paused or resumed run can be found again by ticket id.
    initial_state: GraphState = {"ticket": _graph_ticket(ticket)}
    return graph.invoke(initial_state, config={"configurable": {"thread_id": ticket_id}})


def _saved_checkpoint(graph, ticket_id: str):
    """The saved state of this ticket's run if it ended or paused cleanly, else None.

    "Ended" means nothing is left to run. "Paused" means the only thing left is the
    human_review step, which is where a flagged ticket waits for a reviewer. Anything
    else (a run that stopped halfway, an empty thread, a state missing its results) gives
    None.
    """
    snapshot = graph.get_state({"configurable": {"thread_id": ticket_id}})
    values = snapshot.values or {}
    if not all(key in values for key in _RESULT_KEYS):
        return None
    ended = not snapshot.next
    paused = tuple(snapshot.next) == (_REVIEW_NODE,) and bool(values["needs_human_review"])
    return values if (ended or paused) else None


def _has_checkpoints(graph, ticket_id: str) -> bool:
    snapshot = graph.get_state({"configurable": {"thread_id": ticket_id}})
    return bool(snapshot.values) or bool(snapshot.next)


def _result_from_row(ticket_id: str) -> TriageResult | None:
    record = get_ticket(ticket_id)
    if record is None:
        return None
    # The same fields a fresh triage returns (TicketRecord has more: status, text, ...).
    return TriageResult(**{name: getattr(record, name) for name in TriageResult.model_fields})


def _triage_idempotent(ticket: TicketIn, ticket_id: str, graph) -> TriageResult:
    """Triage a ticket that came with its own id, doing the work at most once.

    The caller holds the advisory lock for this id.
    """
    # a) Already saved: answer from the row. No graph run, so no model calls.
    existing = _result_from_row(ticket_id)
    if existing is not None:
        return existing

    # b) Not saved, but a run left its state behind (the app stopped after the graph
    #    finished, or the save failed). Rebuild the answer from that state: no model calls.
    values = _saved_checkpoint(graph, ticket_id)
    if values is not None:
        result = _build_result(values, ticket_id, _reference_for(ticket))
    else:
        # c) A run that stopped halfway cannot be trusted or resumed from here: clear its
        #    checkpoints (LangGraph's own delete_thread) and run from the start.
        if _has_checkpoints(graph, ticket_id):
            graph.checkpointer.delete_thread(ticket_id)
        result = _build_result(_run_graph(ticket, ticket_id, graph), ticket_id, _reference_for(ticket))

    try:
        return _save(ticket, result)
    except IntegrityError as exc:
        # Another request saved this id first (the lock should make that impossible).
        # Answer from the row that won, never with an error.
        if not is_ticket_id_collision(exc):
            raise
        existing = _result_from_row(ticket_id)
        if existing is None:
            raise
        logger.warning("Ticket id collision on save; returning the existing row")
        return existing


def _record_usage(ticket_id: str, collector: usage_tracking.UsageCollector) -> None:
    """Store what this ticket's model calls used. Never fails the request: it is bookkeeping."""
    if collector.is_empty():
        return
    try:
        attach_usage(ticket_id, collector.summary())
    except Exception:
        logger.exception("Could not store the usage of ticket %s", ticket_id)


@router.post("", response_model=TriageResult)
def triage_ticket(ticket: TicketIn, graph=Depends(get_graph)) -> TriageResult:
    with usage_tracking.collect() as collector:
        result = _triage(ticket, graph)
        _record_usage(result.ticket_id, collector)
    return result


def _triage(ticket: TicketIn, graph) -> TriageResult:
    if ticket.ticket_id is not None:
        ticket_id = str(ticket.ticket_id)
        with ticket_lock(ticket_id):
            return _triage_idempotent(ticket, ticket_id, graph)

    ticket_id = str(uuid4())
    reference = _reference_for(ticket)
    final_state = _run_graph(ticket, ticket_id, graph)

    # A ticket flagged for human review makes the run PAUSE at the human_review step;
    # invoke() then returns the state so far plus an "__interrupt__" entry. The response
    # below is built only from the named keys, so that entry never reaches the client,
    # and a paused run counts as a success (the ticket is saved as pending_review).
    result = _build_result(final_state, ticket_id, reference)

    # Saved only after a successful graph run, so a failed run leaves no row.
    # If the save itself fails the error propagates (503 for a database outage).
    return _save(ticket, result)
