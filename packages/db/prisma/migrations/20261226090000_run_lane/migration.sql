-- Sender-chosen lane for bot-to-bot work; the admission gate runs one bot_message run per lane at a time.
ALTER TABLE "runs" ADD COLUMN "lane" TEXT;
CREATE INDEX "runs_botId_status_lane_idx" ON "runs"("botId", "status", "lane");
