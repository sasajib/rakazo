-- Fork: plan mode "notify" (the plan card is a notice; the agent carries on without waiting).
-- Additive and idempotent. Only the two CHECK constraints widen: a plan setting may be 'notify' and a
-- plan may be decided via 'notify'. No table or column changes; row security is untouched.
-- Rollback: redeploy the previous image. Rows written with 'notify' are then read as "no setting of
-- its own" (the previous code falls back to its default for a mode it does not know) and such
-- plans are already decided, so nothing waits on them.

ALTER TABLE "plan_settings" DROP CONSTRAINT IF EXISTS "plan_settings_mode_check";
ALTER TABLE "plan_settings" ADD CONSTRAINT "plan_settings_mode_check"
  CHECK ("mode" IN ('always', 'until_trusted', 'notify', 'never'));

ALTER TABLE "agent_plans" DROP CONSTRAINT IF EXISTS "agent_plans_decided_via_check";
ALTER TABLE "agent_plans" ADD CONSTRAINT "agent_plans_decided_via_check"
  CHECK ("decidedVia" IS NULL OR "decidedVia" IN ('click', 'voice', 'text', 'trust', 'notify'));
