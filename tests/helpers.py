from langchain_core.messages import AIMessage


def ai_message(
    text: str, stop_reason: str = "end_turn", output_tokens: int = 42
) -> AIMessage:
    """What a Claude call returns: the text, plus why Claude stopped writing.

    stop_reason is "end_turn" when Claude finished, "max_tokens" when it ran out
    of room mid-answer. Used to fake the drafter's chain in tests.
    """
    return AIMessage(
        content=text,
        response_metadata={"stop_reason": stop_reason},
        usage_metadata={
            "input_tokens": 10,
            "output_tokens": output_tokens,
            "total_tokens": 10 + output_tokens,
        },
    )
