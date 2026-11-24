"""Half-said turns: the caller's pauses must not become separate requests."""

from __future__ import annotations

from conversation import UNFINISHED_HOLD_S, looks_unfinished, merge_held

# Real fragments from a call (2026-11-14 04:40-05:00): each one used to start its own run and reply.
REAL_FRAGMENTS = [
    "marge them, and what about the",
    "Did not I give you the",
    "Did you study",
    "I want you to give me the concise summary of and",
    "Why are you... hey. Why are you right on file",
    "Why aren't you reading aloud at the airport",
]
COMPLETE = [
    "Yes.",
    "Hi.",
    "Okay.",
    "Why are you researching?",
    "Stop updating.",
    "I already told you to use the outside agents with us.",
    "Both together, report concise summary in the call.",
]


def test_half_sentences_are_held():
    for text in REAL_FRAGMENTS:
        assert looks_unfinished(text), text


def test_finished_turns_are_not_delayed():
    for text in COMPLETE:
        assert not looks_unfinished(text), text


def test_commands_and_single_words_are_never_held():
    for text in ("stop", "never mind", "go on", "hello", "okay", "please", ""):
        assert not looks_unfinished(text), text


def test_a_dangling_word_holds_even_with_a_closing_mark():
    assert looks_unfinished("I want the summary of and.")


def test_rest_joins_the_held_half_within_the_window():
    assert merge_held("merge them, and what about the", 100.0, "unit economics?", 103.0) == (
        "merge them, and what about the unit economics?"
    )


def test_old_half_sentence_is_dropped():
    assert merge_held("Did you study", 100.0, "What is the weather?", 130.0) == "What is the weather?"
    assert merge_held("", 100.0, "Hello there.", 101.0) == "Hello there."


def test_hold_is_short_enough_to_feel_like_listening():
    assert 0 < UNFINISHED_HOLD_S <= 2.5
