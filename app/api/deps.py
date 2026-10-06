from fastapi import HTTPException, Request

from app.errors import RETRY_AFTER_SECONDS


def get_graph(request: Request):
    """The compiled triage graph, built at startup and kept on app.state.

    It is None while the app is starting, or when startup could not reach the
    database, so callers get a retryable 503 instead of a crash.
    """
    graph = getattr(request.app.state, "triage_graph", None)
    if graph is None:
        raise HTTPException(
            status_code=503,
            detail="Triage is starting up or the database is unavailable. Please retry.",
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )
    return graph
