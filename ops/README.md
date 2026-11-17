# ops: checks for the live Rakazo deployment (bee)

Run from the live stack folder `/home/sasajib/the-data/rakazo` (the scripts read its `.env` and compose files).
Live copy: `/home/sasajib/the-data/rakazo/ops/` — refresh it with `cp ops/*.py ops/README.md /home/sasajib/the-data/rakazo/ops/` after changing these.

- `post-sync-check.py` — run after every upstream sync or image change. Checks the image tag, container health, that our features
  (queue gate, lanes, bot_queue, standing orders, notice ledger) are still in the source, that all migrations are applied, and runs a
  live lane/duplicate test on two throwaway bots (~3 min). `--quick` skips the live test. Exit 0 = all PASS.
- `weekly-self-audit.py [days]` — report on overlapping runs in one lane, long queue waits, repeated messages, blocked-site stops,
  repeated questions and tool-error hot spots. Writes `/home/sasajib/the-data/rakazo-audit/weekly/YYYY-MM-DD.md`.
  Scheduled by a Hermes cron job (Mondays 09:00 Asia/Dhaka).
- `rakazo_rpc.py` — tiny client for Rakazo's web RPC through the signed-in BrowserOS Neo tab (127.0.0.1:9210); finds the open
  agents.mindshare.website tab itself.
