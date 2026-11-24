-- Sender-chosen lane for bot-to-bot work; the admission gate runs one bot_message run per lane at a time.
--
-- The gate only reads a bot's open runs (queued, leased, running). A full (botId, status, lane) index also
-- looked attractive to the planner for bot-wide lookups such as the run lease fence, which wants
-- runs_botId_createdAt_idx. A partial index is invisible to queries that do not name an open status, so
-- those keep their index.
--
-- Idempotent: an instance that already ran the fork's earlier 20261226090000_run_lane and
-- 20261228090100_runs_open_lane_partial_idx migrations has the column and the partial index; the old
-- full index those created first is dropped either way.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "lane" TEXT;
DROP INDEX IF EXISTS "runs_botId_status_lane_idx";
CREATE INDEX IF NOT EXISTS "runs_open_botId_lane_idx" ON "runs"("botId", "lane") WHERE "status" IN ('queued', 'leased', 'running');
