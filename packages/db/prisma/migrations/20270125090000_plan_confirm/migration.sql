-- Fork: plan confirmation cards and workflow trust. Additive and idempotent: the previous release
-- never reads these tables, so it can be rolled back by redeploying the previous image.
--
-- agent_plans     One row per plan revision an agent proposed in a chat, and what the owner did with it
--                 (approve by click / voice / text, ask for changes, reject) and which run carried it out.
-- plan_settings   Always ask / Ask until trusted / Never ask per agent (no row = Ask until trusted, 3).
-- plan_trust      Clean approvals per agent + workflow (skill); at the threshold the agent may run that
--                 workflow without asking. A change request or rejection resets it; the owner can revoke it.

CREATE TABLE IF NOT EXISTS "agent_plans" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT,
    "messageId" TEXT,
    "title" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "inputs" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "spoken" TEXT,
    "workflow" TEXT,
    "skillId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "revisesId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedVia" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executingRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_plans_status_check" CHECK ("status" IN ('pending', 'approved', 'auto', 'changes', 'rejected', 'replaced')),
    CONSTRAINT "agent_plans_decided_via_check" CHECK ("decidedVia" IS NULL OR "decidedVia" IN ('click', 'voice', 'text', 'trust'))
);
CREATE INDEX IF NOT EXISTS "agent_plans_thread_idx" ON "agent_plans"("threadId", "botId", "createdAt");
CREATE INDEX IF NOT EXISTS "agent_plans_executing_idx" ON "agent_plans"("executingRunId");

CREATE TABLE IF NOT EXISTS "plan_settings" (
    "botId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_settings_pkey" PRIMARY KEY ("botId"),
    CONSTRAINT "plan_settings_mode_check" CHECK ("mode" IN ('always', 'until_trusted', 'never'))
);
CREATE INDEX IF NOT EXISTS "plan_settings_spaceId_idx" ON "plan_settings"("spaceId");

CREATE TABLE IF NOT EXISTS "plan_trust" (
    "botId" TEXT NOT NULL,
    -- lower-cased workflow (skill) name
    "workflow" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "skillId" TEXT,
    "approvals" INTEGER NOT NULL DEFAULT 0,
    "lastApprovedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_trust_pkey" PRIMARY KEY ("botId", "workflow")
);
CREATE INDEX IF NOT EXISTS "plan_trust_spaceId_idx" ON "plan_trust"("spaceId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_plans_spaceId_fkey') THEN
    ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_plans_botId_fkey') THEN
    ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_plans_threadId_fkey') THEN
    ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_settings_spaceId_fkey') THEN
    ALTER TABLE "plan_settings" ADD CONSTRAINT "plan_settings_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_settings_botId_fkey') THEN
    ALTER TABLE "plan_settings" ADD CONSTRAINT "plan_settings_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_trust_spaceId_fkey') THEN
    ALTER TABLE "plan_trust" ADD CONSTRAINT "plan_trust_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_trust_botId_fkey') THEN
    ALTER TABLE "plan_trust" ADD CONSTRAINT "plan_trust_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "agent_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_trust" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_plans', 'plan_settings', 'plan_trust']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_tenant') THEN
      EXECUTE format('CREATE POLICY %I ON %I USING ("spaceId" = NULLIF(current_setting(''app.space_id'', true), ''''))', t || '_tenant', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_system') THEN
      EXECUTE format('CREATE POLICY %I ON %I USING ((SELECT app_rls_bypass()))', t || '_system', t);
    END IF;
  END LOOP;
END $$;
