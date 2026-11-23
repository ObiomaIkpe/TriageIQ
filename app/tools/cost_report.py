"""Cost per ticket, from the usage stored on each ticket. Read-only.

    python -m app.tools.cost_report --last 50

Prints the average, median and maximum ESTIMATED cost (US dollars) and the token totals of the newest N
tickets that have a cost. Tickets without one (saved before cost tracking, or answered without any model
call) are counted separately. Prices come from app/config.py: see the sources and date there.
"""
from __future__ import annotations

import argparse
import statistics
from typing import Optional, Sequence

from sqlalchemy import select

from app.db import get_session
from app.tickets.orm import TicketRow


def summarize(rows: Sequence[tuple[Optional[float], Optional[dict]]]) -> dict:
    """rows: (ai_cost_usd, ai_usage) per ticket, newest first. Pure, so it is easy to test."""
    costs = [cost for cost, _ in rows if cost is not None]
    tokens = [usage.get("total_tokens", 0) for cost, usage in rows if cost is not None and usage]
    return {
        "tickets_looked_at": len(rows),
        "tickets_with_cost": len(costs),
        "tickets_without_cost": len(rows) - len(costs),
        "average_usd": statistics.fmean(costs) if costs else None,
        "median_usd": statistics.median(costs) if costs else None,
        "max_usd": max(costs) if costs else None,
        "total_usd": sum(costs) if costs else None,
        "total_tokens": sum(tokens),
    }


def fetch_rows(last: int) -> list[tuple[Optional[float], Optional[dict]]]:
    query = (
        select(TicketRow.ai_cost_usd, TicketRow.ai_usage)
        .order_by(TicketRow.created_at.desc(), TicketRow.id.desc())
        .limit(last)
    )
    with get_session() as session:
        return [(cost, usage) for cost, usage in session.execute(query)]


def format_report(summary: dict, last: int) -> str:
    def usd(value: Optional[float]) -> str:
        return "n/a" if value is None else f"${value:.4f}"

    lines = [
        f"AI cost per ticket (ESTIMATE), newest {last} tickets",
        f"  tickets looked at:     {summary['tickets_looked_at']}",
        f"  with a cost:           {summary['tickets_with_cost']}",
        f"  without a cost:        {summary['tickets_without_cost']}  (before tracking, or no model call)",
        f"  average:               {usd(summary['average_usd'])}",
        f"  median:                {usd(summary['median_usd'])}",
        f"  max:                   {usd(summary['max_usd'])}",
        f"  total:                 {usd(summary['total_usd'])}",
        f"  total tokens:          {summary['total_tokens']:,}",
        "Prices: app/config.py (PRICES_USD_PER_MTOK). Estimate only; check your providers' invoices.",
    ]
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Estimated AI cost per ticket.")
    parser.add_argument("--last", type=int, default=50, help="how many of the newest tickets to look at (default 50)")
    args = parser.parse_args(argv)
    if args.last < 1:
        parser.error("--last must be at least 1")
    print(format_report(summarize(fetch_rows(args.last)), args.last))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
