"""
One-off script to seed the knowledge base with sample FAQ documents.

Run with: python -m app.kb.ingest
"""


from app.kb.store import add_document
from app.migrations import run_migrations

# Each article keeps its original policy sentences word for word (tests/test_kb_articles.py
# pins them); the text around them only explains the same rule in plain customer words.
SAMPLE_DOCS = [
    {
        "topic": "password reset",
        "content": (
            "How to reset your password\n\n"
            "This article is for anyone who has forgotten their password, does not remember it, "
            "or wants to set a new one.\n\n"
            "To reset a password, use the 'Forgot password' link on "
            "the login page. Reset emails expire after 30 minutes.\n\n"
            "What this means for you: if you cannot sign in because you do not remember your "
            "password, start from the login page and select the 'Forgot password' link. "
            "The reset is done through an email, and that email stops working after 30 minutes, "
            "so it is best to open it as soon as it arrives. If more than 30 minutes have passed, "
            "the email can no longer be used to reset the password. In that case, use the "
            "'Forgot password' link on the login page again."
        ),
    },
    {
        "topic": "billing cycle",
        "content": (
            "When you are billed\n\n"
            "This article is for customers who want to know when their subscription payment is "
            "taken each month, and how refunds are worked out.\n\n"
            "Billing occurs on the same calendar day each month as "
            "the original signup date. Refunds are prorated.\n\n"
            "What this means for you: the date you first signed up decides your billing date. "
            "For example, if you signed up on the 12th, you are billed on the 12th of every "
            "month after that. The charge does not move around from month to month. "
            "When a refund is given, it is prorated, which means the amount is worked out "
            "proportionally and not as a flat figure. If you are not sure which day your "
            "billing date falls on, look at the day you originally signed up."
        ),
    },
    {
        "topic": "account lockout",
        "content": (
            "Why your account is locked\n\n"
            "This article is for anyone who is shut out of their account after several unsuccessful "
            "attempts to sign in.\n\n"
            "Accounts lock after 5 failed login attempts within 15 "
            "minutes. Lockout clears automatically after 1 hour.\n\n"
            "What this means for you: if you try to log in and fail 5 times within a 15 minute "
            "window, the account is locked and you cannot get in for a while. This is a "
            "temporary lockout, not a permanent block. You do not need to do anything to "
            "undo it, because the lockout clears automatically after 1 hour. Once that hour "
            "has passed, the account is available again and you can try to log in as usual. "
            "The rule counts failed login attempts over a 15 minute window, and the lock applies "
            "once there have been 5 of them inside that window. Fewer than 5 failed attempts "
            "within 15 minutes does not lock the account."
        ),
    },
    {
        "topic": "subscription cancellation",
        "content": (
            "How to cancel your subscription\n\n"
            "This article is for customers who want to end their subscription, stop their plan "
            "or unsubscribe.\n\n"
            "Subscriptions can be cancelled anytime from Account "
            "Settings > Billing. Access continues until the end of "
            "the current billing period; no partial refunds are "
            "issued for early cancellation.\n\n"
            "What this means for you: you can cancel whenever you like, and you do it yourself "
            "in Account Settings > Billing. After you cancel, you keep your access until the "
            "end of the billing period you are currently in. Cancelling part of the way "
            "through a billing period does not earn a partial refund for the rest of it. "
            "Because access continues until the end of the current billing period, cancelling "
            "does not cut your access off straight away. Early cancellation means cancelling "
            "before that billing period has ended, and no partial refunds are issued in that case."
        ),
    },
    {
        "topic": "two-factor authentication",
        "content": (
            "Two-factor authentication (2FA)\n\n"
            "This article is for customers who want to turn on two-factor authentication, "
            "and for customers who can no longer use their 2FA device.\n\n"
            "Two-factor authentication can be enabled in Account "
            "Settings > Security. If a user loses access to their "
            "2FA device, support can issue a temporary bypass code "
            "after identity verification.\n\n"
            "What this means for you: to add this extra layer of sign-in protection, turn on "
            "two-factor authentication in Account Settings > Security. If you lose the device "
            "you use for 2FA, or otherwise cannot get to it, the way back in is a temporary "
            "bypass code. Support can issue that code, and only after your identity has "
            "been verified. The code is temporary, and identity verification comes first. "
            "Turning two-factor authentication on is something you do yourself in the "
            "Security section of your account settings."
        ),
    },
]


def main() -> None:
    print("Applying database migrations...")
    run_migrations()

    print(f"Ingesting {len(SAMPLE_DOCS)} documents...")
    for doc in SAMPLE_DOCS:
        add_document(doc["topic"], doc["content"])
        print(f"  saved: {doc['topic']}")

    print("Done.")


if __name__ == "__main__":
    main()