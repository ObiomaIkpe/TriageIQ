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
    database_url: str = "postgresql://triageiq:triageiq@localhost:5432/triageiq"
    langchain_tracing_v2: bool = False
    langchain_api_key: str = ""
    langchain_project: str = "triageiq"
    app_env: str = "development"
    log_level: str = "INFO"


settings = Settings()