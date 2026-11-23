from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", protected_namespaces=("settings_",)
    )

    anthropic_api_key: str = ""
    voyage_api_key: str = ""
    # Voyage requests allowed per minute. 3 matches the free tier; raise it
    # (VOYAGE_RPM in .env) once the account has a payment method.
    voyage_rpm: int = 3
    model_id: str = "claude-sonnet-4-6"

    llm_timeout_seconds: float = 30.0
    llm_max_retries: int = 2
    # Longest answer, in tokens, that any of the three Claude calls (classifier,
    # drafter, critic) may produce; an answer that runs longer is cut off. Always
    # sent explicitly, because langchain-anthropic's own default differs between
    # versions (1024 in 0.2.x, the model's maximum in 1.x). 700 is roughly 500 words.
    llm_max_tokens: int = Field(default=700, gt=0)
    # Tickets the classifier is less sure about than this skip retrieval,
    # drafting and critique and go straight to human review.
    low_confidence_threshold: float = 0.6
    # Shared secret for POST /tickets/{id}/review, sent in the X-API-Key header. Empty
    # means the review endpoint is disabled (it answers 503), so a forgotten setting
    # can never leave it open.
    review_api_key: str = ""
    database_url: str = "postgresql://triageiq:triageiq@localhost:5432/triageiq"
    # LangSmith tracing. LangSmith reads these straight from the environment; the
    # app itself never uses them, so they are listed here to document the names.
    # The older LANGCHAIN_* names still work, but use ONE set: if both are present
    # and disagree, tracing is on when either one says true.
    langsmith_tracing: bool = False
    langsmith_api_key: str = ""
    langsmith_project: str = "triageiq"
    app_env: str = "development"
    log_level: str = "INFO"


settings = Settings()


# --- Model prices, used ONLY for the per-ticket cost ESTIMATE (app/usage.py) ---------------------
# US dollars per million tokens, as published on the day below. Prices change: when they do, edit
# this table (and PRICES_AS_OF). An unlisted model is counted in tokens but gets no cost.
# Sources (checked 2026-11-23):
#   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing  (claude-sonnet-4-6: $3 in / $15 out)
#   Voyage:    https://docs.voyageai.com/docs/pricing                    (voyage-3: $0.06, no free tokens)
# Cache-read and cache-write token prices are not modelled: the app does not use prompt caching.
PRICES_AS_OF = "2026-11-23"
PRICES_USD_PER_MTOK: dict[str, dict[str, float]] = {
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "voyage-3": {"input": 0.06, "output": 0.0},
}