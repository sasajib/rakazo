-- Fork (1.32): Space-pinned skills, the "hard rules for every agent". Additive and idempotent: the
-- previous release never reads this table, so it can be rolled back by redeploying the previous image.
--
-- A row = one skill whose body is in the prompt of EVERY agent of its member in the Space, existing
-- and future, whatever the agent's own skill selection (bot_skill_selections) says. Skills belong to
-- the account that added them, so the set is kept per (spaceId, userId).
--   skillRef  the stored skill's id, or 'builtin:<name>' for a built-in skill
--   skillId   the stored skill's id again (NULL for a built-in), so deleting the skill removes its pin
--   pinnedByBotId  the agent that pinned it through the bot_skills tool (NULL = the owner in the app)
CREATE TABLE IF NOT EXISTS "space_pinned_skills" (
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillRef" TEXT NOT NULL,
    "skillId" TEXT,
    "pinnedByBotId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_pinned_skills_pkey" PRIMARY KEY ("spaceId", "userId", "skillRef")
);

CREATE INDEX IF NOT EXISTS "space_pinned_skills_skillId_idx" ON "space_pinned_skills"("skillId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'space_pinned_skills_spaceId_fkey') THEN
    ALTER TABLE "space_pinned_skills" ADD CONSTRAINT "space_pinned_skills_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'space_pinned_skills_skillId_fkey') THEN
    ALTER TABLE "space_pinned_skills" ADD CONSTRAINT "space_pinned_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "agent_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "space_pinned_skills" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'space_pinned_skills' AND policyname = 'space_pinned_skills_system') THEN
    CREATE POLICY space_pinned_skills_system ON "space_pinned_skills" USING ((SELECT app_rls_bypass()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'space_pinned_skills' AND policyname = 'space_pinned_skills_tenant') THEN
    CREATE POLICY space_pinned_skills_tenant ON "space_pinned_skills"
      USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
  END IF;
END $$;
