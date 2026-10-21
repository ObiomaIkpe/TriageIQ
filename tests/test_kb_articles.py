"""The sample KB articles: policy sentences unchanged, realistic length, no extra topics."""
import re

import pytest

from app.kb.ingest import SAMPLE_DOCS

# The original one-sentence articles. The longer articles must contain these verbatim.
ORIGINAL = {
    "password reset": "To reset a password, use the 'Forgot password' link on the login page. "
                      "Reset emails expire after 30 minutes.",
    "billing cycle": "Billing occurs on the same calendar day each month as the original "
                     "signup date. Refunds are prorated.",
    "account lockout": "Accounts lock after 5 failed login attempts within 15 minutes. "
                       "Lockout clears automatically after 1 hour.",
    "subscription cancellation": "Subscriptions can be cancelled anytime from Account "
                                 "Settings > Billing. Access continues until the end of the "
                                 "current billing period; no partial refunds are issued for "
                                 "early cancellation.",
    "two-factor authentication": "Two-factor authentication can be enabled in Account "
                                 "Settings > Security. If a user loses access to their 2FA "
                                 "device, support can issue a temporary bypass code after "
                                 "identity verification.",
}

CONTENT = {doc["topic"]: doc["content"] for doc in SAMPLE_DOCS}


def has_word(text, word):
    return re.search(rf"\b{re.escape(word)}", text, re.IGNORECASE) is not None


def test_the_five_topic_names_are_unchanged():
    assert [doc["topic"] for doc in SAMPLE_DOCS] == list(ORIGINAL)


@pytest.mark.parametrize("topic", ORIGINAL)
def test_original_sentence_appears_verbatim(topic):
    assert ORIGINAL[topic] in CONTENT[topic]


@pytest.mark.parametrize("topic", ORIGINAL)
def test_word_count_is_120_to_200(topic):
    assert 120 <= len(CONTENT[topic].split()) <= 200


def test_lockout_does_not_mention_passwords_resetting_or_support():
    text = CONTENT["account lockout"]
    for word in ("password", "reset", "support", "contact"):
        assert not has_word(text, word), word


def test_cancellation_does_not_mention_prorating():
    assert not has_word(CONTENT["subscription cancellation"], "prorat")


def test_billing_does_not_mention_cancellation():
    text = CONTENT["billing cycle"]
    for word in ("cancel", "cancelled", "cancelling", "cancellation", "unsubscribe"):
        assert not has_word(text, word), word


def test_two_factor_describes_no_self_service_bypass():
    text = CONTENT["two-factor authentication"].lower()
    for phrase in ("yourself generate", "generate a bypass", "self-service", "backup code",
                   "recovery code", "skip"):
        assert phrase not in text, phrase
    # The only route to a bypass code named in the article is support, after verification.
    assert "support can issue that code" in text


LOCKOUT_2FA = ("Failed two-factor authentication codes count as failed login attempts, so "
               "entering a wrong 2FA code 5 times within 15 minutes also locks the account.")
BILLING_PLAN_CHANGE = ("This also applies to plan changes made part of the way through a "
                       "billing period: the difference is prorated.")
CANCELLATION_SCOPE = ("The no-partial-refunds rule applies only to cancelling a subscription; "
                      "plan changes made part of the way through a billing period are covered "
                      "in the billing cycle article.")


def test_lockout_says_failed_2fa_codes_count():
    assert LOCKOUT_2FA in CONTENT["account lockout"]
    assert CONTENT["account lockout"].endswith(LOCKOUT_2FA)


def test_billing_says_plan_changes_are_prorated():
    assert BILLING_PLAN_CHANGE in CONTENT["billing cycle"]
    assert CONTENT["billing cycle"].endswith(BILLING_PLAN_CHANGE)


def test_cancellation_limits_the_no_refund_rule_to_cancelling():
    assert CANCELLATION_SCOPE in CONTENT["subscription cancellation"]
    assert CONTENT["subscription cancellation"].endswith(CANCELLATION_SCOPE)
