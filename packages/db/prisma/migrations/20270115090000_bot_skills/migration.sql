-- Fork: per-agent skills. Additive: the previous release never reads these tables, so it can be
-- rolled back by redeploying the previous image.
--
-- No bot_skill_selections row for a bot = it sees every skill of its space (upstream behaviour).
-- A row = it sees only the stored skills listed in bot_skills, plus every built-in skill not
-- named in excludedBuiltins. Deleting a bot or a skill removes its rows.
--
-- Idempotent, like the fork's other migrations, so a rebased branch can re-run it safely.
CREATE TABLE IF NOT EXISTS "bot_skill_selections" (
    "botId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "excludedBuiltins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_skill_selections_pkey" PRIMARY KEY ("botId")
);

CREATE TABLE IF NOT EXISTS "bot_skills" (
    "botId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_skills_pkey" PRIMARY KEY ("botId","skillId")
);

CREATE INDEX IF NOT EXISTS "bot_skill_selections_spaceId_userId_idx" ON "bot_skill_selections"("spaceId", "userId");
CREATE INDEX IF NOT EXISTS "bot_skills_skillId_idx" ON "bot_skills"("skillId");
CREATE INDEX IF NOT EXISTS "bot_skills_spaceId_userId_idx" ON "bot_skills"("spaceId", "userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_skill_selections_botId_fkey') THEN
    ALTER TABLE "bot_skill_selections" ADD CONSTRAINT "bot_skill_selections_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_skill_selections_spaceId_fkey') THEN
    ALTER TABLE "bot_skill_selections" ADD CONSTRAINT "bot_skill_selections_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_skills_botId_fkey') THEN
    ALTER TABLE "bot_skills" ADD CONSTRAINT "bot_skills_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bot_skill_selections"("botId") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_skills_skillId_fkey') THEN
    ALTER TABLE "bot_skills" ADD CONSTRAINT "bot_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "agent_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "bot_skill_selections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bot_skills" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bot_skill_selections' AND policyname = 'bot_skill_selections_system') THEN
    CREATE POLICY bot_skill_selections_system ON "bot_skill_selections" USING ((SELECT app_rls_bypass()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bot_skill_selections' AND policyname = 'bot_skill_selections_tenant') THEN
    CREATE POLICY bot_skill_selections_tenant ON "bot_skill_selections"
      USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bot_skills' AND policyname = 'bot_skills_system') THEN
    CREATE POLICY bot_skills_system ON "bot_skills" USING ((SELECT app_rls_bypass()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bot_skills' AND policyname = 'bot_skills_tenant') THEN
    CREATE POLICY bot_skills_tenant ON "bot_skills"
      USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
  END IF;
END $$;
