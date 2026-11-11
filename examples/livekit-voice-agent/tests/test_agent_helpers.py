"""Tests for the agent's pure helpers (no LiveKit session needed)."""

from __future__ import annotations

from agent import _unspoken_remainder


def test_speak_final_when_nothing_streamed():
    assert _unspoken_remainder("", "Dhaka is the capital.") == "Dhaka is the capital."


def test_nothing_left_when_deltas_covered_the_reply():
    assert _unspoken_remainder("Dhaka is  the capital.", "Dhaka is the capital.") == ""


def test_tail_when_final_is_longer_than_the_deltas():
    assert _unspoken_remainder("Dhaka is the capital.", "Dhaka is the capital. Anything else?") == " Anything else?"


def test_a_tail_after_a_split_word_does_not_gain_a_space():
    assert _unspoken_remainder("Bo", "Both are created") == "th are created"


def test_long_ids_are_spoken_by_their_ending():
    from conversation import speakable

    assert speakable("Probe One is cmwchrgzaoh8oys4jb3xxqt38 and done.") == "Probe One is id ending qt38 and done."
    assert speakable("Probe One is `cmwchrgzaoh8oys4jb3xxqt38`, ok") == "Probe One is `id ending qt38`, ok"
    assert speakable("the configuration of the deployment") == "the configuration of the deployment"


def test_redacted_final_does_not_replay_a_different_text():
    # The final message is the redacted assembly; if it diverges from what was spoken, stay quiet.
    assert _unspoken_remainder("The code is 1234.", "The code is [redacted].") == ""
    assert _unspoken_remainder("something", "") == ""
