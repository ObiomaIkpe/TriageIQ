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