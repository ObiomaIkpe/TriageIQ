import asyncio
import functools
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.tickets import router as tickets_router
from app.api.triage import router as triage_router
from app.errors import register_error_handlers
from app.graph.build import build_triage_graph
from app.graph.checkpointer import create_checkpointer
from app.kb.bootstrap import init_schema_with_retry
from app.kb.store import check_database
from app.migrations import run_migrations

logger = logging.getLogger(__name__)

# Fewer attempts than the migrations: each one can wait for the pool to open.
GRAPH_STARTUP_ATTEMPTS = 3


def _open_graph(holder: dict) -> None:
    """Create the Postgres checkpointer and compile the graph with it.

    Puts "graph" and "checkpointer" into `holder`, so the retry wrapper (which
    returns only a bool) can hand the results back.
    """
    checkpointer = create_checkpointer()
    try:
        holder["graph"] = build_triage_graph(checkpointer.saver)
    except Exception:
        checkpointer.close()
        raise
    holder["checkpointer"] = checkpointer


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Both steps run in a thread because they may sleep while waiting for
    # Postgres. First apply any pending Alembic migrations ...
    await asyncio.to_thread(init_schema_with_retry, run_migrations)

    # ... then build the graph, with a Postgres checkpointer, once. If that still
    # fails after the retries, the app boots anyway with no graph: /triage and
    # /ready answer 503 until the app is restarted with the database reachable.
    holder: dict = {}
    await asyncio.to_thread(
        init_schema_with_retry,
        functools.partial(_open_graph, holder),
        attempts=GRAPH_STARTUP_ATTEMPTS,
        label="Triage graph startup",
        failure_message=(
            "Could not create the checkpointer and triage graph; "
            "continuing without them"
        ),
    )
    app.state.triage_graph = holder.get("graph")

    yield

    app.state.triage_graph = None
    checkpointer = holder.get("checkpointer")
    if checkpointer is not None:
        await asyncio.to_thread(checkpointer.close)


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
def ready(request: Request):
    """Readiness: Postgres answers, the KB table exists, and the graph is built."""
    try:
        check_database()
    except Exception:
        logger.exception("Readiness check failed")
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "reason": "database unavailable"},
        )
    if getattr(request.app.state, "triage_graph", None) is None:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "reason": "triage graph unavailable"},
        )
    return {"status": "ready"}