from app.models import KbMatch


def format_kb_context(matches: list[KbMatch]) -> str:
    """One line per match: "- [topic] content", joined by newlines."""
    return "\n".join(f"- [{match.topic}] {match.content}" for match in matches)
