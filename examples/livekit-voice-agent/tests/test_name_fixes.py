from name_fixes import fix_names, name_fix_rules


def test_fixes_the_names_a_general_model_gets_wrong():
    assert fix_names("Hi, Omar. What is the status?") == "Hi, Umar. What is the status?"
    assert fix_names("ask barraca and madat") == "ask Barakah and Madad"
    assert fix_names("Omar's report") == "Umar's report"


def test_leaves_ordinary_words_and_longer_words_alone():
    text = "The omarion elm tree, a barrack, and the rule twenty."
    assert fix_names(text) == text


def test_override_from_the_environment(monkeypatch):
    monkeypatch.setenv("VOICE_NAME_FIXES", '{"Ilm": ["elm"]}')
    assert fix_names("hi elm") == "hi Ilm"
    assert fix_names("hi omar", name_fix_rules()) == "hi omar"
