-- Fork: auto-learned skills (the skill curator). Additive and idempotent: the previous release
-- never reads these tables, so it can be rolled back by redeploying the previous image.
--
-- skill_learning_settings  Off / Ask / Auto per agent (id = botId) and per Space (id = 'space:<spaceId>').
-- skill_learning_jobs      One row per finished run the curator must read; a run whose curator never
--                          finished is picked up by the next run in the Space.
-- skill_learning_proposals What the curator proposed (a new skill or a change to one) and what became
--                          of it: the chat card's Keep / Discard writes here.
-- learned_skills           Provenance of skills the curator wrote (agent, run, date). Auto mode may only
--                          change skills listed here; a skill the owner wrote needs his Keep.
-- skill_teaching_sessions  "Let me teach you how to ..." in a chat, until it is saved or cancelled.

CREATE TABLE IF NOT EXISTS "skill_learning_settings" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT,
    "mode" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_learning_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "skill_learning_settings_mode_check" CHECK ("mode" IN ('off', 'ask', 'auto'))
);
CREATE INDEX IF NOT EXISTS "skill_learning_settings_spaceId_idx" ON "skill_learning_settings"("spaceId");

CREATE TABLE IF NOT EXISTS "skill_learning_jobs" (
    "runId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "botId" TEXT,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    -- Tool-call outline of the run (names, redacted and bounded argument summaries, outcomes).
    "outline" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_learning_jobs_pkey" PRIMARY KEY ("runId"),
    CONSTRAINT "skill_learning_jobs_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS "skill_learning_jobs_spaceId_status_idx" ON "skill_learning_jobs"("spaceId", "status", "createdAt");

CREATE TABLE IF NOT EXISTS "skill_learning_proposals" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT,
    "messageId" TEXT,
    "action" TEXT NOT NULL,
    "skillId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "previousContent" TEXT,
    "mode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    -- The owner's own words the proposal rests on.
    "quote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "skill_learning_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "skill_learning_proposals_action_check" CHECK ("action" IN ('create', 'patch')),
    CONSTRAINT "skill_learning_proposals_mode_check" CHECK ("mode" IN ('ask', 'auto')),
    CONSTRAINT "skill_learning_proposals_status_check" CHECK ("status" IN ('pending', 'kept', 'discarded', 'saved', 'reverted', 'failed'))
);
CREATE INDEX IF NOT EXISTS "skill_learning_proposals_spaceId_thread_idx" ON "skill_learning_proposals"("spaceId", "threadId", "status");
CREATE INDEX IF NOT EXISTS "skill_learning_proposals_skillId_idx" ON "skill_learning_proposals"("skillId");

CREATE TABLE IF NOT EXISTS "learned_skills" (
    "skillId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT,
    "botName" TEXT,
    "runId" TEXT,
    "threadId" TEXT,
    "taught" BOOLEAN NOT NULL DEFAULT false,
    "patches" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learned_skills_pkey" PRIMARY KEY ("skillId")
);
CREATE INDEX IF NOT EXISTS "learned_skills_spaceId_idx" ON "learned_skills"("spaceId");

CREATE TABLE IF NOT EXISTS "skill_teaching_sessions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "startSeq" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "skill_teaching_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "skill_teaching_sessions_status_check" CHECK ("status" IN ('active', 'saved', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "skill_teaching_sessions_active_key" ON "skill_teaching_sessions"("threadId", "botId") WHERE "status" = 'active';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_learning_settings_spaceId_fkey') THEN
    ALTER TABLE "skill_learning_settings" ADD CONSTRAINT "skill_learning_settings_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_learning_settings_botId_fkey') THEN
    ALTER TABLE "skill_learning_settings" ADD CONSTRAINT "skill_learning_settings_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_learning_jobs_spaceId_fkey') THEN
    ALTER TABLE "skill_learning_jobs" ADD CONSTRAINT "skill_learning_jobs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_learning_proposals_spaceId_fkey') THEN
    ALTER TABLE "skill_learning_proposals" ADD CONSTRAINT "skill_learning_proposals_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_learning_proposals_botId_fkey') THEN
    ALTER TABLE "skill_learning_proposals" ADD CONSTRAINT "skill_learning_proposals_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_learning_proposals_skillId_fkey') THEN
    ALTER TABLE "skill_learning_proposals" ADD CONSTRAINT "skill_learning_proposals_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "agent_skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_skills_skillId_fkey') THEN
    ALTER TABLE "learned_skills" ADD CONSTRAINT "learned_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "agent_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_skills_spaceId_fkey') THEN
    ALTER TABLE "learned_skills" ADD CONSTRAINT "learned_skills_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_skills_botId_fkey') THEN
    ALTER TABLE "learned_skills" ADD CONSTRAINT "learned_skills_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_teaching_sessions_spaceId_fkey') THEN
    ALTER TABLE "skill_teaching_sessions" ADD CONSTRAINT "skill_teaching_sessions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_teaching_sessions_botId_fkey') THEN
    ALTER TABLE "skill_teaching_sessions" ADD CONSTRAINT "skill_teaching_sessions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "skill_learning_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_learning_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_learning_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "learned_skills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_teaching_sessions" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['skill_learning_settings', 'skill_learning_jobs', 'skill_learning_proposals', 'learned_skills', 'skill_teaching_sessions']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_tenant') THEN
      EXECUTE format('CREATE POLICY %I ON %I USING ("spaceId" = NULLIF(current_setting(''app.space_id'', true), ''''))', t || '_tenant', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_system') THEN
      EXECUTE format('CREATE POLICY %I ON %I USING ((SELECT app_rls_bypass()))', t || '_system', t);
    END IF;
  END LOOP;
END $$;
