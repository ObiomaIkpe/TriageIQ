from fastapi import FastAPI

from app.errors import register_error_handlers
from app.api.triage import router as triage_router

app = FastAPI(
    title="TriageIQ",
    description="LangGraph-powered support ticket classification, RAG-grounded reply drafting, and self-review.",
    version="0.1.0",
)

register_error_handlers(app)
app.include_router(triage_router)


@app.get("/health")
def health():
    return {"status": "ok"}