-- The queue gate only reads a bot's open runs (queued, leased, running). A full (botId, status, lane) index also
-- looked attractive to the planner for bot-wide lookups such as the run lease fence, which wants runs_botId_createdAt_idx.
-- A partial index is invisible to queries that do not name an open status, so those keep their index.
DROP INDEX IF EXISTS "runs_botId_status_lane_idx";
CREATE INDEX "runs_open_botId_lane_idx" ON "runs"("botId", "lane") WHERE "status" IN ('queued', 'leased', 'running');
