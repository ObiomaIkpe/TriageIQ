import secrets

# No 0, O, 1, I or L, so a reference read aloud or copied by hand is not misread.
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
PREFIX = "TKT-"
LENGTH = 6


def new_reference() -> str:
    """A short, human-friendly ticket reference such as TKT-7K3M9Q.

    Not guaranteed unique: the tickets table has a unique constraint, and
    save_ticket retries on a collision.
    """
    return PREFIX + "".join(secrets.choice(ALPHABET) for _ in range(LENGTH))
