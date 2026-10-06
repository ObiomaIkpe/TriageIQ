from app.graph.formatting import format_kb_context
from app.models import KbMatch


def test_no_matches_gives_an_empty_string():
    assert format_kb_context([]) == ""


def test_one_match_is_one_bullet_with_its_topic():
    matches = [KbMatch(topic="password reset", content="Use the reset link.", distance=0.3)]

    assert format_kb_context(matches) == "- [password reset] Use the reset link."


def test_two_matches_are_joined_by_newlines_in_order():
    matches = [
        KbMatch(topic="password reset", content="Use the reset link.", distance=0.3),
        KbMatch(topic="account lockout", content="Lockout clears after 1 hour.", distance=0.4),
    ]

    assert format_kb_context(matches) == (
        "- [password reset] Use the reset link.\n"
        "- [account lockout] Lockout clears after 1 hour."
    )
