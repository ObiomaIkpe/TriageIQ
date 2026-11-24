"""The wall between the REAL room and the DEMO room, on a real Postgres; reviewing seeded tickets; seed and reset.

Python answers only for the scope the gateway asks for, and the scope is honoured only with the service key.
"""
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api.deps import get_graph
from app.config import settings
from app.demo import reset as demo_reset
from app.demo import seed as demo_seed
from app.graph.checkpointer import create_checkpointer
from app.main import app
from app.models import Category, TicketIn, TriageResult, Urgency
from app.tickets import store
from app.tickets.reference import new_reference

pytestmark = pytest.mark.integration
KEY = "dummy-review-key"
HEADERS = {"X-API-Key": KEY}
REVIEWER = {"id": "client:demo-visitor", "name": "Demo Reviewer"}


class NoRunGraph:
    """A graph with no paused run for any ticket (as for a seeded example, and as for a real ticket that is not waiting)."""

    def get_state(self, config):
        return SimpleNamespace(next=(), values={})

    def __getattr__(self, name):
        raise AssertionError(f"the graph was used ({name}): a seeded ticket has no run to resume")


@pytest.fixture
def client(monkeypatch, test_session):
    monkeypatch.setattr(settings, "review_api_key", KEY)
    app.dependency_overrides[get_graph] = lambda: NoRunGraph()
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_graph, None)


def add(*, demo: bool, status="pending_review", draft="A draft."):
    ticket_id = str(uuid.uuid4())
    reference = new_reference()
    result = TriageResult(
        ticket_id=ticket_id, reference=reference, category=Category.account, urgency=Urgency.low,
        confidence=0.9, routing_target="q", needs_human_review=status == "pending_review", suggested_reply=draft,
    )
    store.save_ticket(TicketIn(subject=f"{'demo' if demo else 'real'} subject", body="b", customer_email="x@example.com", is_demo=demo), result)
    if status != "triaged":
        from app.db import get_session

        with get_session() as session:
            session.execute(text("UPDATE tickets SET status = :s WHERE id = :i"), {"s": status, "i": ticket_id})
    return ticket_id, reference


def get(client, url, scope=None, key=True):
    params = {"scope": scope} if scope else {}
    return client.get(url, params=params, headers=HEADERS if key else {})


# --- the wall -------------------------------------------------------------------------------------------------------------

def test_each_scope_lists_only_its_own_tickets(client):
    real_id, _ = add(demo=False)
    demo_id, _ = add(demo=True)
    assert [t["ticket_id"] for t in get(client, "/tickets", "real").json()] == [real_id]
    assert [t["ticket_id"] for t in get(client, "/tickets", "demo").json()] == [demo_id]
    assert get(client, "/tickets", "demo").json()[0]["is_demo"] is True
    assert get(client, "/tickets", "real").json()[0]["is_demo"] is False


def test_counts_are_per_scope(client):
    add(demo=False); add(demo=False, status="approved"); add(demo=True)
    real = get(client, "/tickets/counts", "real").json()
    demo = get(client, "/tickets/counts", "demo").json()
    assert (real["pending_review"], real["approved"]) == (1, 1)
    assert (demo["pending_review"], demo["approved"]) == (1, 0)


def test_a_ticket_on_the_other_side_is_404_by_id_and_by_reference(client):
    real_id, real_ref = add(demo=False)
    demo_id, demo_ref = add(demo=True)
    for url, scope in ((f"/tickets/{demo_id}", "real"), (f"/tickets/reference/{demo_ref}", "real"),
                       (f"/tickets/{real_id}", "demo"), (f"/tickets/reference/{real_ref}", "demo")):
        response = get(client, url, scope)
        assert response.status_code == 404, url
        assert response.json() == {"detail": "Ticket not found"}  # the same words as a ticket that does not exist
    assert get(client, f"/tickets/{demo_id}", "demo").status_code == 200
    assert get(client, f"/tickets/reference/{real_ref}", "real").status_code == 200
    assert get(client, f"/tickets/{uuid.uuid4()}", "demo").json() == {"detail": "Ticket not found"}


def test_reviewing_a_ticket_on_the_other_side_is_404_and_changes_nothing(client):
    real_id, _ = add(demo=False)
    demo_id, _ = add(demo=True)
    body = {"action": "reject", "reviewer": REVIEWER}
    assert client.post(f"/tickets/{real_id}/review?scope=demo", json=body, headers=HEADERS).status_code == 404
    assert client.post(f"/tickets/{demo_id}/review?scope=real", json=body, headers=HEADERS).status_code == 404
    assert client.post(f"/tickets/{demo_id}/review", json=body, headers=HEADERS).status_code == 404  # no scope means real
    assert get(client, f"/tickets/{real_id}", "real").json()["status"] == "pending_review"
    assert get(client, f"/tickets/{demo_id}", "demo").json()["status"] == "pending_review"


def test_no_scope_means_real_and_never_shows_demo_tickets(client):
    real_id, _ = add(demo=False)
    demo_id, demo_ref = add(demo=True)
    assert [t["ticket_id"] for t in client.get("/tickets").json()] == [real_id]
    assert client.get(f"/tickets/{demo_id}").status_code == 404
    assert client.get(f"/tickets/reference/{demo_ref}").status_code == 404
    assert client.get("/tickets/counts").json()["pending_review"] == 1


def test_a_scope_is_honoured_only_with_the_service_key(client):
    add(demo=True)
    assert get(client, "/tickets", "demo", key=False).status_code == 401
    assert client.get("/tickets", params={"scope": "demo"}, headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.get("/tickets/counts", params={"scope": "demo"}).status_code == 401
    assert get(client, "/tickets", "everything").status_code == 422  # only real or demo exist


def test_the_scope_without_a_key_is_refused_even_when_review_is_disabled(client, monkeypatch):
    monkeypatch.setattr(settings, "review_api_key", "")
    assert client.get("/tickets", params={"scope": "demo"}).status_code == 503  # fail closed, like the review route


def test_a_ticket_made_by_the_triage_path_keeps_the_demo_flag(client):
    demo_id, _ = add(demo=True)
    assert store.get_ticket(demo_id).is_demo is True
    assert store.get_ticket(demo_id, "real") is None and store.get_ticket(demo_id, "demo").ticket_id == demo_id


# --- reviewing seeded examples, with no graph ---------------------------------------------------------------------------------

def refs():
    return {e.slug: demo_seed.reference_for(e.slug) for e in demo_seed.EXAMPLES}


def review(client, ticket, body):
    return client.post(f"/tickets/{ticket['ticket_id']}/review?scope=demo", json={"reviewer": REVIEWER, **body}, headers=HEADERS)


def seeded(client, slug):
    demo_seed.seed()
    return get(client, f"/tickets/reference/{refs()[slug]}", "demo").json()


def test_a_seeded_pending_ticket_can_be_approved_without_a_graph(client):
    ticket = seeded(client, "lockout-unsupported-advice")
    response = review(client, ticket, {"action": "approve", "note": "ok"})
    assert response.status_code == 200
    done = response.json()
    assert done["status"] == "approved" and done["final_reply"] == ticket["suggested_reply"]
    assert done["reviewed_by"] == REVIEWER and done["is_demo"] is True


def test_a_seeded_ticket_can_be_edited_and_rejected(client):
    vague = seeded(client, "vague-help")
    edited = review(client, vague, {"action": "edit", "edited_reply": "Hello, what exactly is not working?"})
    assert edited.status_code == 200 and edited.json()["status"] == "edited"
    assert edited.json()["final_reply"] == "Hello, what exactly is not working?"
    billing = get(client, f"/tickets/reference/{refs()['billing-no-kb-match']}", "demo").json()
    rejected = review(client, billing, {"action": "reject", "note": "not now"})
    assert rejected.status_code == 200 and rejected.json()["status"] == "rejected" and rejected.json()["final_reply"] is None


def test_approving_a_seeded_ticket_with_no_draft_is_refused_like_the_graph_does(client):
    vague = seeded(client, "vague-help")
    response = review(client, vague, {"action": "approve"})
    assert response.status_code == 422 and "no draft" in response.json()["detail"]
    assert get(client, f"/tickets/{vague['ticket_id']}", "demo").json()["status"] == "pending_review"


def test_a_second_review_of_a_seeded_ticket_is_409(client):
    ticket = seeded(client, "lockout-unsupported-advice")
    assert review(client, ticket, {"action": "reject"}).status_code == 200
    assert review(client, ticket, {"action": "approve"}).status_code == 409


def test_the_auto_handled_example_can_be_approved_in_one_click(client):
    ticket = seeded(client, "auto-password-reset")
    assert ticket["status"] == "triaged"
    assert review(client, ticket, {"action": "approve"}).json()["status"] == "approved"


def test_a_REAL_pending_ticket_never_takes_the_no_graph_path(client):
    real_id, _ = add(demo=False)
    response = client.post(f"/tickets/{real_id}/review?scope=real", json={"action": "approve", "reviewer": REVIEWER}, headers=HEADERS)
    # the graph says it is not paused: for a real ticket that is "not waiting" (409), never a quiet approval without a run
    assert response.status_code == 409
    assert get(client, f"/tickets/{real_id}", "real").json()["status"] == "pending_review"


# --- seed and reset touch only demo rows -----------------------------------------------------------------------------------------

def _checkpoint_rows(session, thread_id):
    return sum(
        session.execute(text(f"SELECT count(*) FROM {t} WHERE thread_id = :t"), {"t": thread_id}).scalar()
        for t in ("checkpoints", "checkpoint_blobs", "checkpoint_writes")
    )


def _add_checkpoint(session, thread_id):
    session.execute(text(
        "INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata) "
        "VALUES (:t, '', :c, 'msgpack', '{}'::jsonb, '{}'::jsonb)"), {"t": thread_id, "c": str(uuid.uuid4())})
    session.execute(text(
        "INSERT INTO checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob) VALUES (:t, '', 'ticket', '1', 'msgpack', '\\x00')"), {"t": thread_id})
    session.execute(text(
        "INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob) "
        "VALUES (:t, '', :c, 'task', 0, 'ticket', 'msgpack', '\\x00')"), {"t": thread_id, "c": str(uuid.uuid4())})


@pytest.fixture
def with_checkpoint_tables(migrated_database, test_session):
    create_checkpointer(migrated_database).close()  # the library makes its own tables
    return test_session


def test_seed_adds_eight_demo_tickets_and_is_repeatable(client):
    assert demo_seed.seed() == 8
    assert demo_seed.seed() == 0
    assert get(client, "/tickets/counts", "demo").json() == {"triaged": 1, "pending_review": 4, "approved": 1, "edited": 1, "rejected": 1}


def test_seed_never_touches_a_real_ticket(client):
    real_id, _ = add(demo=False)
    before = get(client, f"/tickets/{real_id}", "real").json()
    demo_seed.seed()
    assert get(client, f"/tickets/{real_id}", "real").json() == before
    assert len(get(client, "/tickets", "real").json()) == 1


def test_reset_removes_all_demo_tickets_and_checkpoints_and_puts_the_examples_back(client, with_checkpoint_tables):
    demo_seed.seed()
    visitor_id, _ = add(demo=True)  # something a visitor submitted
    with with_checkpoint_tables() as session:
        _add_checkpoint(session, visitor_id)
        session.commit()
    seeded_ticket = get(client, f"/tickets/reference/{refs()['vague-help']}", "demo").json()
    review(client, seeded_ticket, {"action": "reject"})  # a visitor reviewed an example

    result = demo_reset.reset()

    assert result["tickets"] == 9 and result["checkpoint_rows"] == 3 and result["seeded"] == 8
    assert get(client, f"/tickets/{visitor_id}", "demo").status_code == 404  # gone
    assert get(client, "/tickets/counts", "demo").json() == {"triaged": 1, "pending_review": 4, "approved": 1, "edited": 1, "rejected": 1}
    assert get(client, f"/tickets/reference/{refs()['vague-help']}", "demo").json()["status"] == "pending_review"  # back to pending
    with with_checkpoint_tables() as session:
        assert _checkpoint_rows(session, visitor_id) == 0


def test_reset_never_touches_a_real_ticket_or_its_checkpoints(client, with_checkpoint_tables):
    real_id, real_ref = add(demo=False)
    real_done_id, _ = add(demo=False, status="approved")
    demo_id, _ = add(demo=True)
    with with_checkpoint_tables() as session:
        for thread in (real_id, real_done_id, demo_id):
            _add_checkpoint(session, thread)
        session.commit()
    before = [get(client, f"/tickets/{i}", "real").json() for i in (real_id, real_done_id)]

    demo_reset.reset()
    demo_reset.reset()  # twice: idempotent

    assert [get(client, f"/tickets/{i}", "real").json() for i in (real_id, real_done_id)] == before
    assert get(client, f"/tickets/reference/{real_ref}", "real").status_code == 200
    with with_checkpoint_tables() as session:
        assert _checkpoint_rows(session, real_id) == 3 and _checkpoint_rows(session, real_done_id) == 3  # untouched
        assert _checkpoint_rows(session, demo_id) == 0
    assert len(get(client, "/tickets", "real").json()) == 2
    assert get(client, "/tickets/counts", "demo").json()["pending_review"] == 4


def test_reset_works_before_the_checkpoint_tables_exist(client):
    demo_seed.seed()
    result = demo_reset.reset()  # a fresh database where the app never started: nothing to delete there, no error
    assert result["tickets"] == 8 and result["checkpoint_rows"] == 0 and result["seeded"] == 8


def test_migration_0006_keeps_every_existing_ticket_real(migrated_database):
    from alembic import command
    from tests.integration.conftest import alembic_config
    from sqlalchemy import create_engine, text as sql
    from sqlalchemy.pool import NullPool

    command.downgrade(alembic_config(migrated_database), "0005")
    engine = create_engine(migrated_database, poolclass=NullPool)
    with engine.begin() as conn:
        conn.execute(sql(
            "INSERT INTO tickets (id, reference, status, subject, body, category, urgency, confidence, routing_target, needs_human_review) "
            "VALUES (gen_random_uuid(), 'TKT-AAAAAA', 'triaged', 's', 'b', 'account', 'low', 0.9, 'q', false)"))
    command.upgrade(alembic_config(migrated_database), "head")
    with engine.begin() as conn:
        assert conn.execute(sql("SELECT is_demo FROM tickets")).scalars().all() == [False]
    engine.dispose()
