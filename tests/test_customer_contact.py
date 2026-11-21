"""Public-form fields on POST /triage: reference chosen by the gateway, customer name and email.

No database and no model calls: Claude, the KB search and save_ticket are faked; the graph runs for real.
"""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app.api import triage as triage_api
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.critic import CritiqueResult
from app.main import app
from app.models import Category, ClassificationResult, KbMatch, TicketIn, Urgency
from app.tickets.reference import ALPHABET, REFERENCE_PATTERN, new_reference
from app.tickets.store import REFERENCE_CONSTRAINT
from tests.helpers import ai_message

client = TestClient(app, raise_server_exceptions=False)

NAME = "Ọbiọma Ụzọ"
EMAIL = "customer-secret@example.com"
TICKET = {"subject": "Cannot log in", "body": "Account locked."}
PUBLIC = {**TICKET, "customer_id": "public-form", "customer_name": NAME, "customer_email": EMAIL}
GATEWAY_REFERENCE = "TKT-ABC234"


class Chain:
    def __init__(self, result):
        self.result, self.calls = result, []

    def invoke(self, inputs):
        self.calls.append(inputs)
        return self.result


@pytest.fixture
def world(monkeypatch):
    w = SimpleNamespace(
        classify=Chain(ClassificationResult(category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="r")),
        draft=Chain(ai_message("Your lockout clears after 1 hour.")),
        critic=Chain(CritiqueResult(needs_human_review=False, reason="")),
        saved=[],
        save_error=None,
        save_kwargs=[],
    )
    monkeypatch.setattr(classifier, "_chain", w.classify)
    monkeypatch.setattr(reply_draft, "_chain", w.draft)
    monkeypatch.setattr(critic, "_chain", w.critic)
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda q, top_k: [KbMatch(topic="t", content="c", distance=0.3)])
    monkeypatch.setattr(triage_api, "new_reference", lambda: "TKT-GEN234")

    def save(ticket, result, **kwargs):
        if w.save_error:
            raise w.save_error
        w.saved.append((ticket, result))
        w.save_kwargs.append(kwargs)
        return result.reference

    monkeypatch.setattr(triage_api, "save_ticket", save)
    return w


def everything_the_model_saw(w):
    return repr([w.classify.calls, w.draft.calls, w.critic.calls])


# --- the graph never sees the customer's name or email -----------------------------------------

def test_the_model_never_sees_the_customers_name_or_email(world):
    assert client.post("/triage", json=PUBLIC).status_code == 200

    seen = everything_the_model_saw(world)
    assert world.classify.calls and world.draft.calls and world.critic.calls  # the check is not vacuous
    assert EMAIL not in seen and NAME not in seen and "Ọbiọma" not in seen


def test_the_graph_input_has_no_contact_fields_but_the_saved_ticket_does(world):
    captured = []
    real = triage_api._run_graph

    def spy(ticket, ticket_id, graph):
        captured.append(triage_api._graph_ticket(ticket))
        return real(ticket, ticket_id, graph)

    triage_api._run_graph = spy
    try:
        client.post("/triage", json=PUBLIC)
    finally:
        triage_api._run_graph = real

    assert captured[0].customer_name is None and captured[0].customer_email is None and captured[0].reference is None
    saved_ticket, _ = world.saved[0]
    assert saved_ticket.customer_name == NAME and saved_ticket.customer_email == EMAIL


# --- the reference ---------------------------------------------------------------------------------

def test_a_supplied_reference_is_used_for_the_row_and_the_response(world):
    response = client.post("/triage", json={**TICKET, "reference": GATEWAY_REFERENCE})

    assert response.status_code == 200
    assert response.json()["reference"] == GATEWAY_REFERENCE
    assert world.saved[0][1].reference == GATEWAY_REFERENCE
    assert world.save_kwargs[0] == {"regenerate_reference_on_collision": False}  # a chosen reference is never changed


def test_without_a_reference_one_is_generated_as_before(world):
    response = client.post("/triage", json=TICKET)

    assert response.json()["reference"] == "TKT-GEN234"
    assert world.save_kwargs[0] == {}  # the old retry-with-a-new-one behaviour stays


@pytest.mark.parametrize("bad", [
    "tkt-ABC234", "TKT-ABC23", "TKT-ABC2345", "TKT-ABC23O", "TKT-ABC231", "TKT-ABC23I", "TKT-ABC23L", "TKT-abc234",
    "ABC234", "TKT-ABC 23", "", " TKT-ABC234", "TKT-ABC234\n",
])
def test_a_malformed_reference_is_422(world, bad):
    assert client.post("/triage", json={**TICKET, "reference": bad}).status_code == 422
    assert world.saved == []


def test_the_pattern_accepts_exactly_what_new_reference_makes():
    import re

    for _ in range(300):
        assert re.fullmatch(REFERENCE_PATTERN, new_reference())
    assert set("01OIL").isdisjoint(ALPHABET)


def _reference_collision():
    class Diag:
        constraint_name = REFERENCE_CONSTRAINT

    class Orig(Exception):
        diag = Diag()

    return IntegrityError("INSERT ...", {}, Orig())


def test_a_supplied_reference_that_belongs_to_another_ticket_is_409_reference_conflict(world):
    world.save_error = _reference_collision()

    response = client.post("/triage", json={**TICKET, "reference": GATEWAY_REFERENCE})

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "reference_conflict"


def test_a_collision_without_a_supplied_reference_is_not_turned_into_a_409(world):
    world.save_error = _reference_collision()  # save_ticket would have retried; here the fake raises

    assert client.post("/triage", json=TICKET).status_code == 500


# --- the new fields' limits ---------------------------------------------------------------------------

@pytest.mark.parametrize("field,value,status", [
    ("customer_name", "x" * 100, 200), ("customer_name", "x" * 101, 422), ("customer_name", "", 422),
    ("customer_email", "a" * 242 + "@example.com", 200), ("customer_email", "a" * 243 + "@example.com", 422),
    ("customer_email", "", 422),
])
def test_contact_field_limits(world, field, value, status):
    assert client.post("/triage", json={**TICKET, field: value}).status_code == status


def test_tickets_from_api_clients_still_work_without_any_of_the_new_fields(world):
    ticket = TicketIn(**TICKET)
    assert ticket.reference is None and ticket.customer_name is None and ticket.customer_email is None
    assert client.post("/triage", json=TICKET).status_code == 200
