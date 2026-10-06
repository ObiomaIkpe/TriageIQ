import logging

import anthropic
import psycopg
import sqlalchemy.exc
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

RETRY_AFTER_SECONDS = 30

# Failures that mean "Claude is unavailable right now, try again later".
# Anything else from Anthropic (bad API key, bad request) is a bug on our
# side, not an outage, so it is deliberately left as a 500.
# Names are looked up defensively so a rename in a future SDK can't break import.
_TRANSIENT_NAMES = (
    "APIConnectionError",  # includes APITimeoutError
    "RateLimitError",
    "InternalServerError",
    "OverloadedError",
)
TRANSIENT_LLM_ERRORS = tuple(
    getattr(anthropic, name) for name in _TRANSIENT_NAMES if hasattr(anthropic, name)
)


async def llm_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.warning("LLM unavailable (%s) on %s", type(exc).__name__, request.url.path)
    return JSONResponse(
        status_code=503,
        content={"detail": "Triage is temporarily unavailable. Please retry."},
        headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
    )


async def database_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.warning("Database unavailable (%s) on %s", type(exc).__name__, request.url.path)
    return JSONResponse(
        status_code=503,
        content={"detail": "Database temporarily unavailable. Please retry."},
        headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
    )


def register_error_handlers(app: FastAPI) -> None:
    for exc_class in TRANSIENT_LLM_ERRORS:
        app.add_exception_handler(exc_class, llm_unavailable_handler)
    # SQLAlchemy wraps the driver's error, so both forms mean "database down".
    app.add_exception_handler(psycopg.OperationalError, database_unavailable_handler)
    app.add_exception_handler(
        sqlalchemy.exc.OperationalError, database_unavailable_handler
    )