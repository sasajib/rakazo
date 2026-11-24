-- Memory ledger (fork, additive): facts the owner told the bots of a Space, the links between
-- them, and the writer's per-run bookkeeping. The previous release never reads these tables.
-- Needs pgvector (rakazo/postgres-graph ships it); embeddings stay NULL when no embedding
-- service is configured and search falls back to full-text.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "memory_facts" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "subject" TEXT,
    "text" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "mentions" INTEGER NOT NULL DEFAULT 1,
    "sourceMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "entities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sourceThreadId" TEXT,
    "sourceRunId" TEXT,
    -- Attribution only. A deleted bot leaves the fact (it is the owner's) and clears the credit.
    "writtenByBotId" TEXT,
    "writtenByBotName" TEXT,
    "userId" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "supersedesId" TEXT,
    "askedAt" TIMESTAMP(3),
    "askedThreadId" TEXT,
    "askedMessageId" TEXT,
    "embedding" vector(1024),
    "fts" tsvector GENERATED ALWAYS AS (
        to_tsvector('english'::regconfig, "text" || ' ' || coalesce(replace("subject", '.', ' '), ''))
    ) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_facts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_facts_area_check" CHECK ("area" IN ('about', 'preferences', 'people', 'work', 'lessons')),
    CONSTRAINT "memory_facts_origin_check" CHECK ("origin" IN ('stated', 'inferred')),
    CONSTRAINT "memory_facts_status_check" CHECK ("status" IN ('tentative', 'confirmed', 'disputed', 'superseded', 'retracted')),
    CONSTRAINT "memory_facts_text_check" CHECK (char_length("text") BETWEEN 1 AND 400),
    -- Every fact carries the owner's own words; the server checks they are in an owner message.
    CONSTRAINT "memory_facts_quote_check" CHECK (char_length("quote") BETWEEN 1 AND 400)
);

CREATE INDEX "memory_facts_spaceId_status_idx" ON "memory_facts"("spaceId", "status");
CREATE INDEX "memory_facts_spaceId_subject_idx" ON "memory_facts"("spaceId", "subject");
CREATE INDEX "memory_facts_fts_idx" ON "memory_facts" USING GIN ("fts");

ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_writtenByBotId_fkey" FOREIGN KEY ("writtenByBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "memory_facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "memory_fact_links" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "score" REAL,
    -- On a contradicts link: the owner is asked once per pair.
    "askedAt" TIMESTAMP(3),
    "askedThreadId" TEXT,
    "askedMessageId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_fact_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_fact_links_kind_check" CHECK ("kind" IN ('related', 'supersedes', 'contradicts', 'about_person')),
    CONSTRAINT "memory_fact_links_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('use_new', 'keep_old')),
    CONSTRAINT "memory_fact_links_self_check" CHECK ("fromId" <> "toId")
);

CREATE UNIQUE INDEX "memory_fact_links_fromId_toId_kind_key" ON "memory_fact_links"("fromId", "toId", "kind");
CREATE INDEX "memory_fact_links_toId_idx" ON "memory_fact_links"("toId");
CREATE INDEX "memory_fact_links_spaceId_open_idx" ON "memory_fact_links"("spaceId", "askedThreadId") WHERE "askedAt" IS NOT NULL AND "resolvedAt" IS NULL;

ALTER TABLE "memory_fact_links" ADD CONSTRAINT "memory_fact_links_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_fact_links" ADD CONSTRAINT "memory_fact_links_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "memory_facts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_fact_links" ADD CONSTRAINT "memory_fact_links_toId_fkey" FOREIGN KEY ("toId") REFERENCES "memory_facts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per owner-started run the writer must read; a run whose writer never finished is
-- picked up again by the next run in the Space.
CREATE TABLE "memory_ledger_jobs" (
    "runId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "botId" TEXT,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_ledger_jobs_pkey" PRIMARY KEY ("runId"),
    CONSTRAINT "memory_ledger_jobs_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'failed'))
);

CREATE INDEX "memory_ledger_jobs_spaceId_status_idx" ON "memory_ledger_jobs"("spaceId", "status", "createdAt");

ALTER TABLE "memory_ledger_jobs" ADD CONSTRAINT "memory_ledger_jobs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Space-owned rows: readable and writable only inside the Space's tenant context.
ALTER TABLE "memory_facts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_facts_tenant ON "memory_facts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY memory_facts_system ON "memory_facts"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "memory_fact_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_fact_links_tenant ON "memory_fact_links"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY memory_fact_links_system ON "memory_fact_links"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "memory_ledger_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_ledger_jobs_tenant ON "memory_ledger_jobs"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY memory_ledger_jobs_system ON "memory_ledger_jobs"
  USING ((SELECT app_rls_bypass()));
