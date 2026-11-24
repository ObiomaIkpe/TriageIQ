import secrets
from typing import Literal, Optional

from fastapi import Header, HTTPException, Query

from app.config import settings


def require_review_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    """Allow the request only if X-API-Key matches REVIEW_API_KEY.

    An empty setting disables the endpoint (503) whatever header was sent, so a
    forgotten setting never leaves it open. The setting is read on every request.
    """
    expected = settings.review_api_key
    if not expected:
        raise HTTPException(
            status_code=503, detail="Review is disabled: REVIEW_API_KEY is not set"
        )
    # Constant-time comparison, on bytes so non-ASCII input cannot raise.
    if x_api_key is None or not secrets.compare_digest(
        x_api_key.encode(), expected.encode()
    ):
        raise HTTPException(status_code=401, detail="Missing or invalid API key")


def get_scope(
    scope: Optional[Literal["real", "demo"]] = Query(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> Literal["real", "demo"]:
    """Which side of the real/demo wall this request reads or reviews. Always a value, never "either".

    The gateway sets it from the principal it authenticated: a demo visitor -> "demo", everyone else -> "real". It is
    honoured ONLY with the service key (the same trust as the `reviewer` of a review): a request that names a scope and has
    no valid key is refused (401/503), so nobody who can merely reach this port can ask for demo (or for real) data by
    choosing a scope. A request that names no scope gets "real", the safe side (the demo room is opt-in, never the default).
    """
    if scope is None:
        return "real"
    require_review_key(x_api_key)
    return scope
