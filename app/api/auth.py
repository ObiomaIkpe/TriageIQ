import secrets
from typing import Optional

from fastapi import Header, HTTPException

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
