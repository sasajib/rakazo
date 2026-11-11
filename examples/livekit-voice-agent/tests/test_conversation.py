"""The call's conversation state: turns, topic tracking, and task notes kept out of the way."""

from __future__ import annotations

from conversation import (
    ConversationState,
    asks_for_status,
    belongs_to_turn,
    continues_topic,
    significant_words,
    topic_of,
)


def test_status_questions_are_recognised():
    for text in (
        "What are you working on?",
        "What's the status?",
        "Any update?",
        "How's it going?",
        "Are you still working on the report?",
    ):
        assert asks_for_status(text), text


def test_questions_about_the_subject_are_not_status_questions():
    for text in (
        "What is the capital of Bangladesh?",
        "How do I install the printer driver?",
        "When does the meeting start?",
    ):
        assert not asks_for_status(text), text


def test_topic_is_its_significant_words():
    assert topic_of("Tell me about the pricing page for the new plan") == "pricing page new plan"
    assert "about" not in topic_of("What about the pricing page?")


def test_a_follow_up_continues_the_topic():
    assert continues_topic("And how much does that cost?", "pricing page")
    assert continues_topic("Why?", "pricing page")


def test_a_new_subject_does_not_continue_the_topic():
    assert not continues_topic("Book me a flight to Dubai tomorrow", "pricing page")


def test_only_the_run_this_turn_started_is_an_answer():
    assert belongs_to_turn("run-1", "run-1")
    assert not belongs_to_turn("run-2", "run-1")
    assert not belongs_to_turn(None, "run-1")
    assert not belongs_to_turn("run-1", None)


def test_a_new_turn_kills_the_previous_one():
    state = ConversationState()
    first = state.begin_turn("What is the capital of Bangladesh?")
    assert state.is_current(first.id)
    second = state.begin_turn("And what is the weather there?")
    assert not state.is_current(first.id)
    assert state.is_current(second.id)


def test_a_new_topic_replaces_the_active_topic_and_drops_old_notes():
    state = ConversationState()
    state.begin_turn("Tell me about the pricing page")
    state.note_task_event("run-1", "Crawling competitor prices")
    assert state.status_line("Chief") is not None

    turn = state.begin_turn("Book me a flight to Dubai tomorrow")
    assert turn.kind == "new_topic"
    assert state.active_topic == "book flight dubai tomorrow"
    # The pricing work is not what the caller is talking about any more.
    assert state.status_line("Chief") is None


def test_a_status_turn_does_not_move_the_topic():
    state = ConversationState()
    state.begin_turn("Tell me about the pricing page")
    turn = state.begin_turn("Any update?")
    assert turn.kind == "status"
    assert state.active_topic == topic_of("Tell me about the pricing page")


def test_task_notes_are_coalesced_per_run():
    state = ConversationState()
    for text in ("Crawling page 1", "Crawling page 5", "Comparing prices"):
        state.note_task_event("run-1", text)
    line = state.status_line("Chief")
    assert line is not None
    assert "Comparing prices" in line
    assert line.count(".") <= 2


def test_status_line_reports_how_many_things_are_running():
    state = ConversationState()
    state.note_task_event("run-1", "Crawling prices", now=1.0)
    state.note_task_event("run-2", "Writing the summary", now=2.0)
    line = state.status_line("Chief")
    assert line is not None
    assert "2 things" in line
    assert "Writing the summary" in line


def test_status_line_is_silent_before_anything_has_run():
    assert ConversationState().status_line("Chief") is None


def test_notes_are_dropped_when_their_run_ends():
    state = ConversationState()
    state.note_task_event("run-1", "Crawling prices")
    state.forget_task("run-1")
    assert state.status_line("Chief") is None


def test_notes_are_bounded():
    state = ConversationState(max_notes=3)
    for index in range(10):
        state.note_task_event(f"run-{index}", f"step {index}", now=float(index))
    assert len(state.notes) == 3
    assert "step 9" in (state.status_line("Chief") or "")


def test_conversation_holds_turns_not_task_progress():
    state = ConversationState()
    state.begin_turn("What is the capital of Bangladesh?")
    state.record_reply("Dhaka is the capital.")
    state.note_task_event("run-9", "Crawling page 1")
    assert [turn.text for turn in state.conversation()] == ["What is the capital of Bangladesh?"]
    assert list(state.replies) == ["Dhaka is the capital."]


def test_significant_words_strip_filler():
    words = significant_words("What about that thing you said")
    for filler in ("what", "about", "that", "you"):
        assert filler not in words


def test_an_empty_turn_is_a_new_topic_with_no_words():
    state = ConversationState()
    turn = state.begin_turn("   ")
    assert turn.kind == "new_topic"
    assert state.active_topic == ""
