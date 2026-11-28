-- Fork (FORK.md 1.42, message routing and concurrent chat tasks). Additive: the previous release
-- ignores the new columns, so it can be rolled back by redeploying the previous image.
--
-- "runs"."chatTask": the run was started as its own task beside other work of the agent in the same
-- chat (a person's message routed as a NEW TASK). Such runs may work at the same time as another
-- task of the chat; their replies quote the message that started them.
-- "runs"."transientRetries": how many times the run was put back in the queue after a transient
-- model or provider failure (RUN_TRANSIENT_RETRY).
-- "steering_messages"."routeHeldUntil": a person's message that is being routed (override,
-- addition, answer or new task) is not taken as steering before this time, so the running task
-- does not read a message that turns out to start another task.
--
-- Idempotent, like the fork's other migrations, so a rebased branch can re-run it safely.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "chatTask" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "transientRetries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "steering_messages" ADD COLUMN IF NOT EXISTS "routeHeldUntil" TIMESTAMP(3);
