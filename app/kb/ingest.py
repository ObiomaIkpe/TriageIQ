"""
One-off script to seed the knowledge base with sample FAQ documents.

Run with: python -m app.kb.ingest
"""
import time

from app.kb.store import init_schema, add_document

SAMPLE_DOCS = [
    {
        "topic": "password reset",
        "content": "To reset a password, use the 'Forgot password' link on "
                    "the login page. Reset emails expire after 30 minutes.",
    },
    {
        "topic": "billing cycle",
        "content": "Billing occurs on the same calendar day each month as "
                    "the original signup date. Refunds are prorated.",
    },
    {
        "topic": "account lockout",
        "content": "Accounts lock after 5 failed login attempts within 15 "
                    "minutes. Lockout clears automatically after 1 hour.",
    },
    {
        "topic": "subscription cancellation",
        "content": "Subscriptions can be cancelled anytime from Account "
                    "Settings > Billing. Access continues until the end of "
                    "the current billing period; no partial refunds are "
                    "issued for early cancellation.",
    },
    {
        "topic": "two-factor authentication",
        "content": "Two-factor authentication can be enabled in Account "
                    "Settings > Security. If a user loses access to their "
                    "2FA device, support can issue a temporary bypass code "
                    "after identity verification.",
    },
]


def main() -> None:
    print("Initializing schema...")
    init_schema()

    print(f"Ingesting {len(SAMPLE_DOCS)} documents...")
    for i, doc in enumerate(SAMPLE_DOCS):
        add_document(doc["topic"], doc["content"])
        print(f"  saved: {doc['topic']}")

    print("Done.")


if __name__ == "__main__":
    main()