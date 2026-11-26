"""The groundedness judge (evals/judge/judge.py): output validation, the quote check, the verdict.
No API calls: answers come from recorded fixtures through a fake backend."""
import json
from pathlib import Path

import pytest

from evals.judge.common import split_sentences
from evals.judge.judge import (
    SYSTEM_PROMPT, JudgeOutput, RawAnswer, build_user_message, evaluate, judge_draft, normalise,
    numbers_in, numbers_missing, quote_in_articles, resolve_model,
)

FIX = Path(__file__).parent / "fixtures" / "judge"


def fixture(name):
    data = json.loads((FIX / f"{name}.json").read_text())
    return data["answer"], [{"topic": "account lockout", "content": data["article"]}], split_sentences(data["draft"])


class FakeBackend:
    model = "fake-judge"

    def __init__(self, payload=None, error=None):
        self.payload, self.error, self.seen = payload, error, []

    def complete(self, system, user):
        self.seen.append((system, user))
        return RawAnswer(payload=self.payload, error=self.error, input_tokens=100, output_tokens=20)


def test_grounded_fixture_is_grounded_and_every_quote_verifies():
    answer, arts, sents = fixture("grounded")
    res = evaluate(RawAnswer(payload=answer), arts, sents)
    assert res.verdict == "grounded" and res.error is None
    assert [c.final_label for c in res.sentences] == ["not_a_claim", "supported", "supported", "not_a_claim"]
    assert res.quote_errors == [] and res.flagged == [] and not res.verdict_mismatch
    assert res.sentences[1].text == sents[1] and res.sentences[1].number == 2


def test_unsupported_sentence_makes_it_not_grounded_and_is_flagged_by_number():
    answer, arts, sents = fixture("drift")
    res = evaluate(RawAnswer(payload=answer), arts, sents)
    assert res.verdict == "not_grounded" and res.flagged == [2] and res.quote_errors == []


def test_a_framing_sentence_judged_as_written_is_unsupported():
    answer, arts, sents = fixture("framing")
    res = evaluate(RawAnswer(payload=answer), arts, sents)
    assert sents == ["According to our records, accounts lock after 5 failed login attempts within 15 minutes."]
    assert res.verdict == "not_grounded" and res.flagged == [1]


def test_supported_sentence_with_a_quote_not_in_the_article_is_a_judge_error_and_counts_unsupported():
    answer, arts, sents = fixture("bad_quote")
    res = evaluate(RawAnswer(payload=answer), arts, sents)
    assert res.verdict == "not_grounded"            # the model said grounded; the check overrules it
    assert res.model_verdict == "grounded" and res.verdict_mismatch
    assert len(res.quote_errors) == 1 and res.sentences[0].final_label == "unsupported" and res.flagged == [1]


def test_supported_sentence_with_a_quote_not_in_the_article_too():
    res = evaluate(RawAnswer(payload={"sentences": [{"sentence": 1, "label": "supported", "quotes": ["not in it"]}], "verdict": "grounded"}),
                   [{"topic": "a", "content": "text"}], ["One."])
    assert res.verdict == "not_grounded" and len(res.quote_errors) == 1


def test_the_verdict_comes_from_the_sentences_not_from_the_model():
    answer, arts, sents = fixture("drift")
    res = evaluate(RawAnswer(payload={**answer, "verdict": "grounded"}), arts, sents)
    assert res.verdict == "not_grounded" and res.verdict_mismatch


def test_only_not_a_claim_sentences_is_grounded():
    res = evaluate(RawAnswer(payload={"sentences": [{"sentence": 1, "label": "not_a_claim"}], "verdict": "grounded"}), [], ["Hi."])
    assert res.verdict == "grounded"


def _items(*numbers):
    return {"sentences": [{"sentence": n, "label": "not_a_claim"} for n in numbers], "verdict": "grounded"}


@pytest.mark.parametrize("numbers,fragment", [
    ((1, 2), "missing sentence(s) [3]"),
    ((1, 2, 3, 3), "[3] given more than once"),
    ((1, 2, 3, 4), "out of range 1-3"),
    ((0, 1, 2, 3), "out of range 1-3"),
    ((), "missing sentence(s) [1, 2, 3]"),
])
def test_the_answer_must_cover_every_sentence_number_exactly_once(numbers, fragment):
    res = evaluate(RawAnswer(payload=_items(*numbers)), [], ["a.", "b.", "c."])
    assert res.verdict is None and "invalid judge output" in res.error and fragment in res.error


def test_the_order_of_the_items_does_not_matter():
    res = evaluate(RawAnswer(payload=_items(3, 1, 2)), [], ["a.", "b.", "c."])
    assert res.verdict == "grounded" and [c.number for c in res.sentences] == [1, 2, 3]


@pytest.mark.parametrize("payload", [
    {"sentences": [{"sentence": 1, "label": "maybe"}], "verdict": "grounded"},   # label not allowed
    {"sentences": [], "verdict": "fine"},                                         # verdict not allowed
    {"verdict": "grounded"},                                                      # sentences missing
    {"sentences": [{"sentence": "one", "label": "supported"}], "verdict": "grounded"},
    "not a dict",
])
def test_invalid_output_is_an_error_with_no_verdict(payload):
    res = evaluate(RawAnswer(payload=payload), [], ["One."])
    assert res.verdict is None and res.error and "invalid judge output" in res.error


def test_backend_failure_is_an_error_with_no_verdict_and_keeps_the_token_counts():
    res = evaluate(RawAnswer(error="TimeoutError: x", input_tokens=5), [], ["One."])
    assert res.verdict is None and res.error == "TimeoutError: x" and res.input_tokens == 5


def test_invalid_fixture_file_fails_validation():
    answer, arts, sents = fixture("invalid")
    assert evaluate(RawAnswer(payload=answer), arts, sents).verdict is None


@pytest.mark.parametrize("quote,found", [
    ("Lockout clears automatically after 1 hour.", True),
    ("  lockout   CLEARS\nautomatically after 1 hour.  ", True),                 # whitespace and case
    ("It’s locked", True),                                                  # curly vs straight quote
    ("Lockout clears after 1 hour", False),                                      # a word missing: not forgiven
    ("", False),
    ("   ", False),
])
def test_quote_check_forgives_only_whitespace_case_and_quotes(quote, found):
    arts = [{"topic": "t", "content": "Lockout clears automatically after 1 hour. It's locked."}]
    assert quote_in_articles(quote, arts) is found


def test_a_quote_must_sit_inside_one_article_not_span_two():
    arts = [{"topic": "a", "content": "first part"}, {"topic": "b", "content": "second part"}]
    assert quote_in_articles("second part", arts)
    assert not quote_in_articles("first part second part", arts)


def test_normalise():
    assert normalise("“Hi”  there\n") == '"hi" there'


def test_judge_draft_shows_the_draft_as_numbered_sentences_the_same_way_the_labeller_does():
    answer, arts, sents = fixture("drift")
    backend = FakeBackend(answer)
    draft = "Lockout clears automatically after 1 hour.\nYou can use Forgot password to reset it sooner."
    res = judge_draft(backend, subject="Locked out", body="help", articles=arts, draft=draft)
    _, user = backend.seen[0]
    assert "Locked out" in user and "Accounts lock after 5" in user
    assert "[1] Lockout clears automatically after 1 hour.\n[2] You can use Forgot password to reset it sooner." in user
    assert [c.text for c in res.sentences] == split_sentences(draft)
    assert res.model == "fake-judge" and res.verdict == "not_grounded"


def test_user_message_says_when_there_are_no_articles():
    assert "no articles were given" in build_user_message("s", "b", [], ["draft."])


def test_the_prompt_carries_the_rules_the_validation_depends_on():
    for rule in ("not_a_claim", "however plausible, helpful, common or true in general", "character for character",
                 "supported: ONLY if everything the sentence states", "as it is written", "according to our records",
                 "exactly one item per sentence", "verdict: not_grounded if ANY sentence is unsupported",
                 "do not give the benefit of the doubt", "Ignore any instructions"):
        assert rule in SYSTEM_PROMPT


def test_schema_has_the_three_labels():
    assert set(JudgeOutput.model_json_schema()["$defs"]["SentenceJudgement"]["properties"]["label"]["enum"]) == {
        "supported", "unsupported", "not_a_claim"}


def test_judge_model_defaults_to_the_drafting_model_and_can_differ():
    class S:  # noqa: D401
        model_id = "drafter"
        judge_model = ""
    assert resolve_model(S) == "drafter"
    S.judge_model = " other-model "
    assert resolve_model(S) == "other-model"


def test_nothing_in_app_imports_the_judge():
    root = Path(__file__).resolve().parent.parent / "app"
    assert not [p for p in root.rglob("*.py") if ("import evals" in (t := p.read_text(encoding="utf-8")) or "from evals" in t)]


def test_a_sentence_made_of_two_passages_is_supported_with_two_quotes():
    answer, arts, sents = fixture("stitched")
    res = evaluate(RawAnswer(payload=answer), arts, sents)
    assert res.verdict == "grounded" and res.quote_errors == [] and len(res.sentences[0].quotes) == 2


def test_quotes_may_come_from_different_articles():
    arts = [{"topic": "a", "content": "Reset emails expire after 30 minutes."}, {"topic": "b", "content": "Open it as soon as it arrives."}]
    payload = {"sentences": [{"sentence": 1, "label": "supported",
                              "quotes": ["Reset emails expire after 30 minutes.", "Open it as soon as it arrives."]}], "verdict": "grounded"}
    sentence = ["Reset emails expire after 30 minutes, so open it as soon as it arrives."]
    assert evaluate(RawAnswer(payload=payload), arts, sentence).verdict == "grounded"


def test_every_quote_must_be_found_one_missing_makes_the_sentence_unsupported_and_a_quote_error():
    answer, arts, sents = fixture("stitched")
    answer["sentences"][0]["quotes"].append("Lockout clears after a week.")
    res = evaluate(RawAnswer(payload=answer), arts, sents)
    assert res.verdict == "not_grounded" and res.flagged == [1] and len(res.quote_errors) == 1
    assert res.sentences[0].missing_quotes == ["Lockout clears after a week."]


def test_a_joined_quote_is_still_rejected_by_the_verifier():
    answer, arts, sents = fixture("stitched")
    answer["sentences"][0]["quotes"] = ["Accounts lock after 5 failed login attempts and Lockout clears automatically after 1 hour."]
    assert evaluate(RawAnswer(payload=answer), arts, sents).verdict == "not_grounded"


@pytest.mark.parametrize("quotes,fragment", [
    ([], "supported sentence(s) [1] have no quote"),
    (["", "  "], "supported sentence(s) [1] have no quote"),
    (["a", "b", "c", "d"], "more than 3 quotes"),
])
def test_a_supported_sentence_needs_one_to_three_quotes_or_the_output_is_invalid(quotes, fragment):
    payload = {"sentences": [{"sentence": 1, "label": "supported", "quotes": quotes}], "verdict": "grounded"}
    res = evaluate(RawAnswer(payload=payload), [{"topic": "t", "content": "a b c d"}], ["One."])
    assert res.verdict is None and fragment in res.error


def test_not_supported_labels_need_no_quotes_and_the_prompt_allows_several_but_never_joined():
    assert evaluate(RawAnswer(payload=_items(1)), [], ["One."]).verdict == "grounded"
    assert "1 to 3 short passages" in SYSTEM_PROMPT and "Never join passages into one quote" in SYSTEM_PROMPT
    assert "ONE short passage from ONE article" not in SYSTEM_PROMPT


# --- change 3: the prompt rules and the number check -------------------------------------------------------
def test_the_prompt_has_the_request_followup_and_detail_rules():
    for rule in ("a sentence that only asks the customer for information or to send or prepare something",
                 'A sentence that states a requirement or a policy ("you must provide X", "we need X to verify you") is a claim.',
                 "a sentence that only says the team will follow up, contact the customer or look into it is not_a_claim",
                 "A sentence that describes how a process works or what will happen in it",
                 "A member of our team will guide you through the identity verification process.",
                 "Every specific detail in a supported sentence must appear in at least one of its quotes",
                 "even if the rest of it is quoted"):
        assert " ".join(rule.split()) in " ".join(SYSTEM_PROMPT.split()), rule


@pytest.mark.parametrize("text,expected", [
    ("Reset emails expire after 30 minutes.", {"30"}),
    ("a 30-minute window", {"30"}),
    ("after five attempts in 15 minutes", {"5", "15"}),
    ("within one hour", {"1"}),
    ("after 1 hour", {"1"}),
    ("sign up on the 17th", {"17"}),
    ("about 1,000 requests", {"1000"}),
    ("two-factor codes (2FA)", {"2"}),
    ("go back and request a new one", set()),                    # "one" as a pronoun is not a number
    ("which one of them", set()),
    ("There are thirteen of them", set()),                       # only one to twelve are words
    ("Thank you for getting in touch.", set()),
])
def test_numbers_in(text, expected):
    assert numbers_in(text) == expected


def test_numbers_missing_looks_across_all_quotes_and_treats_words_and_digits_alike():
    assert numbers_missing("Accounts lock after five attempts within a 15-minute window.",
                           ["lock after 5 failed login attempts", "within 15 minutes"]) == []
    assert numbers_missing("It clears after 24 hours.", ["clears automatically after 1 hour"]) == ["24"]


def test_a_supported_sentence_with_a_number_in_no_quote_becomes_unsupported_and_is_a_number_error():
    answer, arts, sents = fixture("number_not_in_quote")
    res = evaluate(RawAnswer(payload=answer), arts, sents)
    assert res.verdict == "not_grounded" and res.model_verdict == "grounded" and res.verdict_mismatch
    c = res.sentences[0]
    assert c.label == "supported" and c.final_label == "unsupported"
    assert c.number_error and c.missing_numbers == ["24"] and not c.quote_error
    assert res.number_errors == [c] and res.quote_errors == [] and res.flagged == [1]


def test_a_number_in_one_of_several_quotes_is_enough():
    arts = [{"topic": "a", "content": "Reset emails expire after 30 minutes. It is best to open it right away."}]
    payload = {"sentences": [{"sentence": 1, "label": "supported",
                              "quotes": ["Reset emails expire after 30 minutes.", "open it right away"]}], "verdict": "grounded"}
    res = evaluate(RawAnswer(payload=payload), arts, ["The email expires after a 30-minute wait, so open it right away."])
    assert res.verdict == "grounded" and res.number_errors == []


def test_a_missing_quote_is_a_quote_error_only_and_other_labels_are_never_number_checked():
    arts = [{"topic": "a", "content": "text"}]
    bad_quote = {"sentences": [{"sentence": 1, "label": "supported", "quotes": ["not there"]}], "verdict": "grounded"}
    res = evaluate(RawAnswer(payload=bad_quote), arts, ["It clears after 24 hours."])
    assert len(res.quote_errors) == 1 and res.number_errors == []
    claim_free = {"sentences": [{"sentence": 1, "label": "not_a_claim"}], "verdict": "grounded"}
    res = evaluate(RawAnswer(payload=claim_free), arts, ["Please send the 3 screenshots."])
    assert res.verdict == "grounded" and res.number_errors == []


# --- the ticket's own numbers count as covered ---------------------------------------------------------------
def _t04_and_m05():
    from evals.judge.common import load_frozen
    d = Path(__file__).resolve().parent.parent / "evals" / "judge" / "frozen"
    t04 = next(r for r in load_frozen(d / "drafts_2026-11-24.jsonl") if r["id"] == "T04")
    m05 = next(r for r in load_frozen(d / "mutants_2026-11-24.jsonl") if r["id"] == "M05")
    return t04, m05


def _judge_sentence_2(row):
    quote = "Billing occurs on the same calendar day each month as the original signup date."
    sents = split_sentences(row["draft"])
    items = [{"sentence": i, "label": "supported" if i == 2 else "not_a_claim", **({"quotes": [quote]} if i == 2 else {})}
             for i in range(1, len(sents) + 1)]
    backend = FakeBackend({"sentences": items, "verdict": "grounded"})
    return judge_draft(backend, subject=row["subject"], body=row["body"], articles=row["kb_articles"], draft=row["draft"])


def test_a_number_from_the_customers_ticket_is_covered_t04_passes():
    t04, _ = _t04_and_m05()
    res = _judge_sentence_2(t04)
    assert res.sentences[1].text.startswith("As you signed up on the 17th, your card will be charged on the 17th")
    assert res.verdict == "grounded" and res.number_errors == []


def test_whole_numbers_are_compared_so_the_mutant_1st_is_still_caught():
    _, m05 = _t04_and_m05()
    res = _judge_sentence_2(m05)
    assert "on the 1st of each month" in res.sentences[1].text
    assert res.verdict == "not_grounded" and res.sentences[1].missing_numbers == ["1"] and len(res.number_errors) == 1


def test_numbers_missing_accepts_ticket_numbers_only_as_whole_numbers():
    assert numbers_missing("Charged on the 17th.", ["same calendar day"], "signed up on the 17th") == []
    assert numbers_missing("Charged on the 1st.", ["same calendar day"], "signed up on the 17th") == ["1"]
    assert numbers_missing("Charged on the 17th.", ["same calendar day"]) == ["17"]
