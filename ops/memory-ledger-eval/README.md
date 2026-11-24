# Memory-ledger eval (live instance)

Scripted conversations that check the ledger from the database, not from what a bot says.
Run against a **throwaway bot** on an instance where `MEMORY_LEDGER=1` and migration
`20261231235500_memory_ledger` are deployed; archive the bot afterwards.

```
python3 ops/memory-ledger-eval/run_eval.py --list
python3 ops/memory-ledger-eval/run_eval.py --neo --bot-id <throwaway-bot-id> --report $TMPDIR/ledger-eval.json
python3 ops/memory-ledger-eval/run_eval.py --neo --bot-id <id> --only contradiction-asks-once
```

- `--neo` sends through the signed-in BrowserOS Neo tab (`--neo-host`, default
  `agents.mindshare.website/`); `--base-url` + `--cookie-file` sends with a session cookie instead.
- Database checks run `docker exec rakazo-postgres-1 psql -U rakazo -d rakazo` (flags to change).
- Each run uses a fresh nonce in every invented name, so scenarios never touch real facts and can
  be re-run. Nothing is deleted.
- A first message to a brand-new bot answers its intro card; send one throwaway message first.

Scenarios (`scenarios.json`): stated fact, explicit remember, repeat confirms, correction
supersedes, contradiction of a confirmed fact asks once and "new" settles it, and five that must
NOT be saved: a question, a card number, one-off task details, pasted third-party text with an
injected "remember", and web-page content the bot read. The last two depend on the memory model
(the quote gate passes pasted text in an owner message by design), so they measure the model.
