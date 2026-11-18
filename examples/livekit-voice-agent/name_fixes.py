"""Put the bots' names right in a local recogniser's transcript.

A general speech model has never seen "Umar", "Barakah" or "Rakazo" and writes the nearest English words
("Omar", "Barraca"). Whole-word, case-insensitive replacements only; a real English word is never listed
(e.g. "elm" for Ilm), because turning it into a name would corrupt ordinary speech.
Override the table with VOICE_NAME_FIXES='{"Umar": ["omar", "umer"]}'.
"""

from __future__ import annotations

import json
import os
import re

DEFAULT_NAME_FIXES: dict[str, list[str]] = {
    "Umar": ["Omar", "Oomar", "Oumar", "Umer", "Umor"],
    "Barakah": ["Baraka", "Barraka", "Barraca", "Barika", "Baraca", "Barakha", "Barakat"],
    "Madad": ["Madat", "Mudad", "Madud", "Mudud"],
    "Rakazo": ["Racazo", "Rakaso", "Rakazzo", "Rocazo", "Rakkazo", "Rakazu"],
}


def name_fix_rules() -> list[tuple[re.Pattern[str], str]]:
    raw = os.environ.get("VOICE_NAME_FIXES")
    fixes = json.loads(raw) if raw else DEFAULT_NAME_FIXES
    return [
        (re.compile(r"\b(?:" + "|".join(re.escape(a) for a in alts) + r")(?=\b|'s)", re.I), canon)
        for canon, alts in fixes.items()
        if alts
    ]


def fix_names(text: str, rules: list[tuple[re.Pattern[str], str]] | None = None) -> str:
    for pattern, canon in rules if rules is not None else name_fix_rules():
        text = pattern.sub(canon, text)
    return text
