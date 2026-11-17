-- Additive: the previous release never reads this table. Needs the pgvector extension (the Postgres image ships it).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "standing_embeddings" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "embedding" vector(1024),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "standing_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "standing_embeddings_spaceId_key_key" ON "standing_embeddings"("spaceId", "key");

ALTER TABLE "standing_embeddings" ADD CONSTRAINT "standing_embeddings_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "standing_embeddings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY standing_embeddings_system ON "standing_embeddings"
  USING ((SELECT app_rls_bypass()));
CREATE POLICY standing_embeddings_tenant ON "standing_embeddings"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
