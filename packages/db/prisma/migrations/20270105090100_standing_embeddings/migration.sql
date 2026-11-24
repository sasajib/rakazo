-- Additive: the previous release never reads this table. One embedding per standing order (STANDING.md
-- line), used only to suggest which orders relate; a derived copy that holds no rule text.
--
-- The vector column needs pgvector. On a Postgres without the extension the table is still created,
-- with the column as a float array, and the code that reads it fails soft (no suggestions).
-- Idempotent: an instance that already ran the fork's earlier 20261228090000_standing_embeddings
-- migration keeps its table, keys and policies, and this one changes nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'standing_embeddings' AND relkind = 'r') THEN
    EXECUTE format(
      'CREATE TABLE "standing_embeddings" (
         "id" TEXT NOT NULL,
         "spaceId" TEXT NOT NULL,
         "key" TEXT NOT NULL,
         "textHash" TEXT NOT NULL,
         "embedding" %s,
         "updatedAt" TIMESTAMP(3) NOT NULL,
         CONSTRAINT "standing_embeddings_pkey" PRIMARY KEY ("id")
       )',
      CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
        THEN 'vector(1024)' ELSE 'DOUBLE PRECISION[]' END
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "standing_embeddings_spaceId_key_key" ON "standing_embeddings"("spaceId", "key");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'standing_embeddings_spaceId_fkey') THEN
    ALTER TABLE "standing_embeddings" ADD CONSTRAINT "standing_embeddings_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "standing_embeddings" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'standing_embeddings' AND policyname = 'standing_embeddings_system') THEN
    CREATE POLICY standing_embeddings_system ON "standing_embeddings" USING ((SELECT app_rls_bypass()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'standing_embeddings' AND policyname = 'standing_embeddings_tenant') THEN
    CREATE POLICY standing_embeddings_tenant ON "standing_embeddings"
      USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
  END IF;
END $$;
