from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", protected_namespaces=("settings_",))

    anthropic_api_key: str = ""
    voyage_api_key: str = ""
    voyage_rpm: int = 3
    model_id: str = "claude-sonnet-4-6"
    database_url: str = "postgresql://triageiq:triageiq@localhost:5432/triageiq"
    langchain_tracing_v2: bool = False
    langchain_api_key: str = ""
    langchain_project: str = "triageiq"
    app_env: str = "development"
    log_level: str = "INFO"


settings = Settings()