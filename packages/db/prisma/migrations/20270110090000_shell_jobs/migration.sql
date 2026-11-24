-- Fork: background shell jobs (slice A of BACKGROUND-JOBS-DESIGN.md). Additive: the previous release
-- never reads this table, so it can be rolled back by redeploying the previous image.
--
-- One row per detached shell command on a bot's computer. The command and its output stay on the
-- computer; the row keeps only a redacted preview of the command, the job's state and the claim-once
-- `returnedAt` stamp that makes its result come back exactly once.
--
-- Idempotent, like the fork's other migrations, so a rebased branch can re-run it safely.
CREATE TABLE IF NOT EXISTS "shell_jobs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "originRunId" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "commandPreview" TEXT NOT NULL,
    "cwd" TEXT,
    "jobDir" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "exitCode" INTEGER,
    "pid" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "nextPollAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "pollErrors" INTEGER NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "returnedAt" TIMESTAMP(3),
    "deliveredAs" TEXT,
    "wakeRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shell_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "shell_jobs_status_nextPollAt_idx" ON "shell_jobs"("status", "nextPollAt");
CREATE INDEX IF NOT EXISTS "shell_jobs_threadId_status_idx" ON "shell_jobs"("threadId", "status");
CREATE INDEX IF NOT EXISTS "shell_jobs_botId_status_idx" ON "shell_jobs"("botId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shell_jobs_spaceId_fkey') THEN
    ALTER TABLE "shell_jobs" ADD CONSTRAINT "shell_jobs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shell_jobs_botId_fkey') THEN
    ALTER TABLE "shell_jobs" ADD CONSTRAINT "shell_jobs_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shell_jobs_threadId_fkey') THEN
    ALTER TABLE "shell_jobs" ADD CONSTRAINT "shell_jobs_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "shell_jobs" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'shell_jobs' AND policyname = 'shell_jobs_system') THEN
    CREATE POLICY shell_jobs_system ON "shell_jobs" USING ((SELECT app_rls_bypass()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'shell_jobs' AND policyname = 'shell_jobs_tenant') THEN
    CREATE POLICY shell_jobs_tenant ON "shell_jobs"
      USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
  END IF;
END $$;
