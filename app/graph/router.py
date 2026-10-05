from app.models import GraphState, Category

ROUTING_MAP = {
    Category.billing: "billing-team",
    Category.technical: "technical-support",
    Category.account: "account-management",
    Category.shipping: "shipping-team",
    Category.other: "general-queue",
}


def route(state: GraphState) -> GraphState:
    classification = state["classification"]
    target = ROUTING_MAP.get(classification.category, "general-queue")

    if classification.urgency.value in ("high", "critical"):
        target = f"{target}-urgent"

    return {"routing_target": target}