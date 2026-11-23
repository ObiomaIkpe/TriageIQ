"""Token usage of the model calls made for one ticket, and an ESTIMATED cost in US dollars.

How it works: the endpoint opens `collect()` around one ticket. Every Claude call (a LangChain
callback, `usage_callback`) and every Voyage embedding call (`record_embedding`) adds its token
counts to the collector that is current in that context. A call made while no collector is open
(KB ingest, tests) is ignored. The context variable reaches LangGraph's worker threads.

Everything here is an ESTIMATE: tokens come from the providers' own usage numbers, the prices from
the table in app/config.py (PRICES_USD_PER_MTOK). Only calls that succeeded are counted, and only
those of the run that produced the saved ticket.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator, Optional

from langchain_core.callbacks import BaseCallbackHandler

from app import config

SUMMARY_VERSION = 1

_current: ContextVar[Optional["UsageCollector"]] = ContextVar("triageiq_usage", default=None)


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> Optional[float]:
    """Estimated dollars for one model's tokens, or None if the model has no price."""
    price = config.PRICES_USD_PER_MTOK.get(model)
    if price is None:
        return None
    return (input_tokens * price["input"] + output_tokens * price["output"]) / 1_000_000


class UsageCollector:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # (provider, model) -> [calls, input_tokens, output_tokens]
        self._totals: dict[tuple[str, str], list[int]] = {}

    def add(self, provider: str, model: str, input_tokens: int, output_tokens: int = 0) -> None:
        with self._lock:
            entry = self._totals.setdefault((provider, model), [0, 0, 0])
            entry[0] += 1
            entry[1] += max(int(input_tokens), 0)
            entry[2] += max(int(output_tokens), 0)

    def is_empty(self) -> bool:
        return not self._totals

    def summary(self) -> dict[str, Any]:
        """A JSON-ready summary: per model, per provider, and the grand totals."""
        with self._lock:
            items = sorted(self._totals.items())
        by_model: list[dict[str, Any]] = []
        providers: dict[str, dict[str, int]] = {}
        total_cost: Optional[float] = 0.0
        for (provider, model), (calls, tokens_in, tokens_out) in items:
            cost = cost_usd(model, tokens_in, tokens_out)
            by_model.append({
                "provider": provider,
                "model": model,
                "calls": calls,
                "input_tokens": tokens_in,
                "output_tokens": tokens_out,
                "estimated_cost_usd": cost,
            })
            totals = providers.setdefault(provider, {"calls": 0, "total_tokens": 0})
            totals["calls"] += calls
            totals["total_tokens"] += tokens_in + tokens_out
            # One unpriced model makes the grand total unknown rather than silently too low.
            total_cost = None if (cost is None or total_cost is None) else total_cost + cost
        return {
            "version": SUMMARY_VERSION,
            "estimate": True,
            "prices_as_of": config.PRICES_AS_OF,
            "by_model": by_model,
            "providers": providers,
            "total_tokens": sum(p["total_tokens"] for p in providers.values()),
            "estimated_cost_usd": None if total_cost is None else round(total_cost, 6),
        }


@contextmanager
def collect() -> Iterator[UsageCollector]:
    collector = UsageCollector()
    token = _current.set(collector)
    try:
        yield collector
    finally:
        _current.reset(token)


def current() -> Optional[UsageCollector]:
    return _current.get()


def record_embedding(model: str, tokens: Any) -> None:
    """Voyage reports one token total per embedding call. Anything that is not a number is ignored."""
    collector = _current.get()
    if collector is not None and isinstance(tokens, int) and not isinstance(tokens, bool):
        collector.add("voyage", model, tokens, 0)


class UsageCallback(BaseCallbackHandler):
    """Attached to each ChatAnthropic: reads the token counts of every finished Claude call."""

    def on_llm_end(self, response, **kwargs: Any) -> None:  # noqa: D401
        collector = _current.get()
        if collector is None:
            return
        try:
            for generations in response.generations:
                for generation in generations:
                    message = getattr(generation, "message", None)
                    usage = getattr(message, "usage_metadata", None) or {}
                    tokens_in, tokens_out = usage.get("input_tokens"), usage.get("output_tokens")
                    if not isinstance(tokens_in, int) or not isinstance(tokens_out, int):
                        continue
                    meta = getattr(message, "response_metadata", None) or {}
                    model = meta.get("model_name") or meta.get("model") or config.settings.model_id
                    collector.add("anthropic", str(model), tokens_in, tokens_out)
        except Exception:  # cost accounting must never break a model call
            pass


usage_callback = UsageCallback()
