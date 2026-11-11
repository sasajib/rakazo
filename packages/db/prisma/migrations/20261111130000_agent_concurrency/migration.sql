-- A bot may use more than one execution slot.
--
-- Additive and behaviour-preserving: concurrency defaults to 1 and the existing lease row of every
-- bot already sits in slot 0, so an instance that never raises a bot's concurrency keeps the
-- one-run-per-bot rule it has today.
--
-- The lease unique key gains the slot column: (computerId, botId, slot) is the slot, and two runs
-- of one bot can only hold different slots. Dropping the old key would let a race create two
-- leases for slot 0, so the new key must exist before the old one goes.
ALTER TABLE "bots" ADD COLUMN "concurrency" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "computer_execution_leases" ADD COLUMN "slot" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "computer_execution_leases_computerId_botId_slot_key"
  ON "computer_execution_leases"("computerId", "botId", "slot");

DROP INDEX "computer_execution_leases_computerId_botId_key";
