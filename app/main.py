import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.api.tickets import router as tickets_router
from app.api.triage import router as triage_router
from app.errors import register_error_handlers
from app.kb.bootstrap import init_schema_with_retry
from app.kb.store import check_database, init_schema
from app.tickets.store import init_ticket_schema

logger = logging.getLogger(__name__)


def init_all_schemas() -> None:
    init_schema()
    init_ticket_schema()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Runs in a thread because it may sleep while waiting for Postgres.
    await asyncio.to_thread(init_schema_with_retry, init_all_schemas)
    yield


app = FastAPI(
    title="TriageIQ",
    description="LangGraph-powered support ticket classification, RAG-grounded reply drafting, and self-review.",
    version="0.1.0",
    lifespan=lifespan,
)

register_error_handlers(app)
app.include_router(triage_router)
app.include_router(tickets_router)


@app.get("/health")
def health():
    """Liveness: the process is up."""
    return {"status": "ok"}


@app.get("/ready")
def ready():
    """Readiness: Postgres answers and the knowledge base table exists."""
    try:
        check_database()
    except Exception:
        logger.exception("Readiness check failed")
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "reason": "database unavailable"},
        )
    return {"status": "ready"}