"""The call's conversation state: turns, topic tracking, and task notes kept out of the way."""

from __future__ import annotations

from conversation import (
    SpokenLines,
    ConversationState,
    asks_for_status,
    asks_for_work,
    spoken_decision_action,
    asks_to_continue,
    asks_question,
    is_filler,
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


def test_only_a_question_earns_an_answer():
    assert asks_question("What is the capital of Bangladesh?")
    assert asks_question("how long will that take")
    assert not asks_question("hmm")
    assert not asks_question("okay")
    assert not asks_question("")


def test_filler_is_recognised():
    for said in ("hmm", "okay", "go on", "right", "and?", "continue"):
        assert is_filler(said), said
    assert not is_filler("create the voice test agent")


def test_filler_after_a_question_keeps_answering_it():
    state = ConversationState()
    state.begin_turn("What is the capital of Bangladesh?")
    assert state.wants_answer("hmm") is True
    assert state.wants_answer("go on") is True


def test_filler_after_a_task_lets_the_task_report():
    state = ConversationState()
    state.begin_turn("Create the voice test agent and the document")
    assert state.wants_answer("okay") is False
    assert state.wants_answer("hmm") is False


def test_a_new_question_starts_a_new_answer():
    # The agent opens a turn for every utterance, then asks whether it must be answered.
    state = ConversationState()
    state.begin_turn("Create the voice test agent")
    assert state.wants_answer("okay") is False

    state.begin_turn("what is the capital of Bangladesh?")
    assert state.wants_answer("what is the capital of Bangladesh?") is True
    state.begin_turn("hmm")
    assert state.wants_answer("hmm") is True


def test_only_an_ask_for_the_rest_counts_as_continue():
    for said in ("go on", "continue", "yes please", "the rest", "read it"):
        assert asks_to_continue(said), said
    for said in ("what is the capital of Bangladesh?", "create the agent", "stop"):
        assert not asks_to_continue(said), said


def test_an_interrupted_report_is_offered_once_after_the_answer():
    state = ConversationState()
    state.begin_turn("Create the voice test agent")
    state.note_task_event("run-task", "The document has a voice section, a test plan and a rollout.")
    state.note_report_interrupted("run-task")

    offer = state.take_report_offer("Chief")
    assert offer is not None
    assert "go on" in offer
    # Asking again does not nag the caller.
    assert state.take_report_offer("Chief") is None


def test_go_on_speaks_the_interrupted_report_and_clears_it():
    state = ConversationState()
    state.note_task_event("run-task", "The document has a voice section and a test plan.")
    state.note_report_interrupted("run-task")
    assert state.has_paused_report()
    assert state.resume_report() == "The document has a voice section and a test plan."
    assert not state.has_paused_report()
    assert state.resume_report() is None


def test_a_new_subject_keeps_the_interrupted_report_offered():
    state = ConversationState()
    state.begin_turn("Create the voice test agent")
    state.note_task_event("run-task", "Half a report")
    state.note_report_interrupted("run-task")
    state.begin_turn("Book me a flight to Dubai tomorrow")
    # Moving on is not a refusal: "go on" still works, and the offer is not repeated.
    assert state.has_paused_report()
    assert state.take_report_offer("Chief") is not None
    assert state.take_report_offer("Chief") is None
    assert state.resume_report() == "Half a report"


def test_a_question_after_an_interruption_still_gets_its_own_answer():
    state = ConversationState()
    state.begin_turn("Create the voice test agent")
    state.note_task_event("run-task", "The document has a voice section and a test plan.")
    state.note_report_interrupted("run-task")
    state.begin_turn("What is the capital of Bangladesh?")
    assert state.wants_answer("What is the capital of Bangladesh?") is True
    # The interrupted update is still offered, not lost, after that answer.
    assert state.has_paused_report()


ACTIONS = [{"id": "allow", "label": "Allow once"}, {"id": "always", "label": "Always allow"}, {"id": "deny", "label": "Deny"}]


def test_a_caller_can_approve_out_loud():
    assert spoken_decision_action("approve", ACTIONS) == "allow"
    assert spoken_decision_action("yes, go ahead", ACTIONS) == "allow"
    assert spoken_decision_action("always allow this", ACTIONS) == "always"


def test_a_caller_can_deny_out_loud():
    assert spoken_decision_action("no", ACTIONS) == "deny"
    assert spoken_decision_action("cancel that", ACTIONS) == "deny"


def test_an_unclear_answer_is_not_consent():
    for said in ("hmm", "", "what is it asking", "wait a second"):
        assert spoken_decision_action(said, ACTIONS) is None, said


def test_no_actions_means_no_decision():
    assert spoken_decision_action("approve", []) is None


def test_a_line_spoken_once_is_not_spoken_again():
    spoken = SpokenLines()
    spoken.add("New Delhi is the capital of India.")
    assert spoken.has("New Delhi is the capital of India")
    assert spoken.has("new delhi is the capital of india.")


def test_a_progress_line_and_its_final_message_count_as_one():
    spoken = SpokenLines()
    spoken.add("New Delhi is the capital of India. Finishing the Voice Test explanation now")
    # The final message opens with the same words: the caller already heard it.
    assert spoken.has("New Delhi is the capital of India.")
    assert spoken.has("New Delhi is the capital of India. Finishing the Voice Test explanation now.")


def test_a_genuinely_new_line_is_still_spoken():
    spoken = SpokenLines()
    spoken.add("New Delhi is the capital of India.")
    assert not spoken.has("The sleep finished forty-four seconds in, so the task is done.")


def test_an_empty_line_is_never_new():
    assert SpokenLines().has("   ")

