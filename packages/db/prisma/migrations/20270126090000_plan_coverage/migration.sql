-- Fork: what an approved plan covers. Additive and idempotent: the previous release never reads the
-- column, so it can be rolled back by redeploying the previous image.
--
-- agent_plans.recipients   JSON array of the ids of the agents that were sent a request under the plan.
--                          An approved plan that is still live covers the owner's corrections and
--                          follow-ups to those agents (and to the agents its steps name) without a new card.
--                          No new table: row security of agent_plans (20270125090000_plan_confirm) applies.

ALTER TABLE "agent_plans" ADD COLUMN IF NOT EXISTS "recipients" JSONB NOT NULL DEFAULT '[]'::jsonb;
