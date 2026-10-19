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
    database_url: str = "postgresql://triageiq:triageiq@localhost:5432/triageiq"
    langchain_tracing_v2: bool = False
    langchain_api_key: str = ""
    langchain_project: str = "triageiq"
    app_env: str = "development"
    log_level: str = "INFO"


settings = Settings()