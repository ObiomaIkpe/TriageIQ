import re

from app.tickets import reference
from app.tickets.reference import ALPHABET, new_reference

LOOK_ALIKES = set("0O1IL")


def test_a_reference_is_tkt_dash_six_characters():
    assert re.fullmatch(r"TKT-[A-Z2-9]{6}", new_reference())


def test_the_alphabet_has_no_look_alike_characters():
    assert not LOOK_ALIKES & set(ALPHABET)
    assert len(ALPHABET) == len(set(ALPHABET)) == 31


def test_every_generated_character_comes_from_the_alphabet():
    for _ in range(2000):
        assert set(new_reference()[4:]) <= set(ALPHABET)


def test_a_few_thousand_references_have_no_duplicates():
    # 31**6 is about 887 million values, so 3000 draws collide about 0.5% of the time
    # by pure chance. A second batch is drawn before the test fails, which makes a
    # false failure vanishingly rare while a broken (low-entropy) generator still fails.
    for _ in range(2):
        draws = [new_reference() for _ in range(3000)]
        if len(set(draws)) == len(draws):
            return
    raise AssertionError("two batches of 3000 references both had duplicates")


def test_it_uses_the_secrets_module_not_random():
    source = open(reference.__file__).read()

    assert "import secrets" in source
    assert "import random" not in source
    assert "random." not in source
