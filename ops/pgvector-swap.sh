#!/usr/bin/env bash
# Move Rakazo's Postgres from postgres:16 to the pgvector image, by export and import.
#   ops/pgvector-swap.sh rehearse   restore the live data into a scratch container and compare (live stack untouched)
#   ops/pgvector-swap.sh swap       real swap: stop app, final dump, tar the old volume (rollback), new image, restore, verify
#   ops/pgvector-swap.sh rollback   put the old image and the tar'd volume back
# Both images are Debian 13 / PG 16, so the only data-affecting change is 16.15 -> 16.16 (same major).
set -euo pipefail
ROOT=/home/sasajib/the-data/rakazo
cd "$ROOT"
NEW_IMAGE=${NEW_IMAGE:-pgvector/pgvector:pg16-trixie}
OLD_IMAGE='postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5'
STAMP=$(date +%Y%m%d-%H%M)
BK=$ROOT/backups/pgswap-$STAMP
COMPOSE=(docker compose --env-file .env -f docker-compose.images.yml -f docker-compose.override.yml)
APP_SERVICES=(web api worker supervisor)
PGU=rakazo
PGDB=rakazo

q() { docker exec "$1" psql -U "$PGU" -d "${3:-$PGDB}" -At -c "$2"; }

counts() { # container -> "schema.table rows" per table, exact
  local c=$1
  q "$c" "select format('%I.%I', schemaname, tablename) from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1" |
    while read -r t; do echo "$t $(q "$c" "select count(*) from $t")"; done
}

shape() { # container -> object counts that a bad restore would change
  q "$1" "select 'policies', count(*) from pg_policy
    union all select 'indexes', count(*) from pg_indexes where schemaname not in ('pg_catalog','information_schema')
    union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not in ('pg_catalog','information_schema','ag_catalog') and p.prokind <> 'a' and not exists (select 1 from pg_depend d where d.objid=p.oid and d.classid='pg_proc'::regclass and d.deptype='e')
    union all select 'sequences', count(*) from pg_sequences
    union all select 'triggers', count(*) from pg_trigger where not tgisinternal
    union all select 'roles', count(*) from pg_roles where rolname !~ '^pg_'
    union all select 'migrations', count(*) from _prisma_migrations" | sort
}

dump_live() { # container destdir
  mkdir -p "$2"
  docker exec "$1" pg_dumpall -U "$PGU" --globals-only >"$2/globals.sql"
  docker exec "$1" pg_dump -U "$PGU" -Fc "$PGDB" >"$2/$PGDB.dump"
  ls -l "$2" | awk 'NR>1{print "  dumped", $9, $5, "bytes"}'
}

restore_into() { # container srcdir
  local c=$1 d=$2
  # the bootstrap superuser already exists; every other role, with its password hash, comes from globals.sql
  docker exec -i "$c" psql -U "$PGU" -d postgres -v ON_ERROR_STOP=0 <"$d/globals.sql" >/dev/null 2>"$d/globals.restore.log" || true
  docker exec "$c" psql -U "$PGU" -d postgres -c "create database $PGDB" >/dev/null 2>&1 || true
  docker exec "$c" psql -U "$PGU" -d "$PGDB" -c "create extension if not exists vector" >/dev/null
  docker exec -i "$c" pg_restore -U "$PGU" -d "$PGDB" --exit-on-error --no-privileges --role="$PGU" <"$d/$PGDB.dump" >"$d/restore.log" 2>&1 ||
    { echo "RESTORE FAILED, see $d/restore.log"; tail -5 "$d/restore.log"; return 1; }
}

compare() { # oldcontainer newcontainer
  counts "$1" >/tmp/pg-old.counts; counts "$2" >/tmp/pg-new.counts
  shape "$1" >/tmp/pg-old.shape; shape "$2" >/tmp/pg-new.shape
  local bad=0
  if diff -q /tmp/pg-old.counts /tmp/pg-new.counts >/dev/null; then echo "PASS row counts identical in $(wc -l </tmp/pg-old.counts) tables ($(awk '{s+=$2} END{print s}' /tmp/pg-old.counts) rows)"; else echo "FAIL row counts differ:"; diff /tmp/pg-old.counts /tmp/pg-new.counts | head -20; bad=1; fi
  if diff -q /tmp/pg-old.shape /tmp/pg-new.shape >/dev/null; then echo "PASS objects identical: $(tr '\n' ' ' </tmp/pg-old.shape)"; else echo "FAIL object counts differ:"; diff /tmp/pg-old.shape /tmp/pg-new.shape; bad=1; fi
  q "$2" "select extname || ' ' || extversion from pg_extension where extname='vector'" | sed 's/^/INFO extension /'
  q "$2" "select 1 from pg_roles where rolname='rakazo_app' and rolcanlogin" | grep -q 1 && echo "PASS app role rakazo_app present" || { echo "FAIL app role missing"; bad=1; }
  return $bad
}

graph_test() { # container: pgvector + AGE work, and an AGE graph survives dump and restore
  local c=$1 bad=0
  docker exec "$c" psql -U "$PGU" -d "$PGDB" -c "create extension if not exists age" >/dev/null || { echo "FAIL create extension age"; return 1; }
  docker exec "$c" psql -U "$PGU" -d "$PGDB" -At -c "select ag_catalog.drop_graph('rule_test', true)" >/dev/null 2>&1 || true
  docker exec "$c" psql -U "$PGU" -d "$PGDB" -At -c "select * from ag_catalog.create_graph('rule_test')" >/dev/null
  docker exec "$c" psql -U "$PGU" -d "$PGDB" -At -c "select * from ag_catalog.cypher('rule_test', \$\$ CREATE (:Rule {key:'r5'})-[:EXCEPTION_OF]->(:Rule {key:'r5b'}), (:Rule {key:'r3'})-[:OVERRIDES]->(:Rule {key:'r16'}) \$\$) as (a ag_catalog.agtype)" >/dev/null
  local n; n=$(docker exec "$c" psql -U "$PGU" -d "$PGDB" -At -c "set search_path = ag_catalog, public" -c "select * from ag_catalog.cypher('rule_test', \$\$ MATCH (a:Rule)-[e]->(b:Rule) RETURN count(e) \$\$) as (n ag_catalog.agtype)" | tail -1)
  [ "$n" = "2" ] && echo "PASS AGE graph query returns 2 edges" || { echo "FAIL AGE graph query: $n"; bad=1; }
  local v; v=$(docker exec "$c" psql -U "$PGU" -d "$PGDB" -At -c "select '[1,2,3]'::vector <-> '[1,2,4]'::vector")
  [ "$v" = "1" ] && echo "PASS pgvector distance works" || { echo "FAIL pgvector: $v"; bad=1; }
  if [ "${2:-}" = "roundtrip" ]; then
    # round trip: dump this database, restore into a fresh one, query the graph again
    docker exec "$c" pg_dump -U "$PGU" -Fc "$PGDB" >/tmp/graph-rt.dump
    docker exec "$c" psql -U "$PGU" -d postgres -c "drop database if exists rt" -c "create database rt" >/dev/null
    docker exec "$c" psql -U "$PGU" -d rt -c "create extension if not exists vector" >/dev/null
    docker exec -i "$c" pg_restore -U "$PGU" -d rt --no-privileges --role="$PGU" </tmp/graph-rt.dump >/tmp/graph-rt.log 2>&1 || true
    n=$(docker exec "$c" psql -U "$PGU" -d rt -At -c "set search_path = ag_catalog, public" -c "select * from ag_catalog.cypher('rule_test', \$\$ MATCH (a:Rule)-[e]->(b:Rule) RETURN count(e) \$\$) as (n ag_catalog.agtype)" 2>&1 | tail -1)
    [ "$n" = "2" ] && echo "PASS AGE graph survives dump and restore" || echo "INFO known AGE limit: a graph does not survive pg_dump/restore (got: $n). Keep rules and links in ordinary tables; rebuild the graph from them after a restore."
    docker exec "$c" psql -U "$PGU" -d postgres -c "drop database rt" >/dev/null
  fi
  docker exec "$c" psql -U "$PGU" -d "$PGDB" -At -c "select ag_catalog.drop_graph('rule_test', true)" >/dev/null
  return $bad
}

rehearse() {
  docker rm -f pg-rehearsal >/dev/null 2>&1 || true
  docker volume rm -f rehearsal_pg >/dev/null 2>&1 || true
  echo "dumping live database (app keeps running)"; dump_live rakazo-postgres-1 "$BK"
  docker run -d --name pg-rehearsal -e POSTGRES_USER=$PGU -e POSTGRES_PASSWORD=rehearsal -v rehearsal_pg:/var/lib/postgresql/data "$NEW_IMAGE" >/dev/null
  for i in $(seq 1 40); do docker exec pg-rehearsal pg_isready -U $PGU >/dev/null 2>&1 && break; sleep 2; done
  restore_into pg-rehearsal "$BK"
  echo "-- compare live vs rehearsal (live may drift by a few rows while the app runs)"
  compare rakazo-postgres-1 pg-rehearsal || echo "REHEARSAL: differences above (queue-job drift while the app runs is expected)"
  graph_test pg-rehearsal roundtrip || echo "REHEARSAL: graph test failed"
  docker rm -f pg-rehearsal >/dev/null; docker volume rm -f rehearsal_pg >/dev/null
  echo "rehearsal done; backup dir $BK"
}

swap() {
  command -v jq >/dev/null || true
  local live; live=$(q rakazo-postgres-1 "select count(*) from runs where status in ('running','leased')")
  [ "$live" = "0" ] || { echo "ABORT: $live runs active"; exit 2; }
  echo "stopping app services"; "${COMPOSE[@]}" stop "${APP_SERVICES[@]}" >/dev/null
  echo "final dump (no writers)"; dump_live rakazo-postgres-1 "$BK"
  counts rakazo-postgres-1 >"$BK/old.counts"; shape rakazo-postgres-1 >"$BK/old.shape"
  echo "stopping old postgres and archiving its volume (rollback copy)"
  "${COMPOSE[@]}" stop postgres >/dev/null
  docker run --rm -v rakazo_pgdata:/from:ro -v "$BK":/to busybox:1 tar czf /to/pgdata-volume.tgz -C /from .
  ls -l "$BK/pgdata-volume.tgz" | awk '{print "  volume archive", $5, "bytes"}'
  echo "emptying the volume and starting $NEW_IMAGE"
  docker rm -f rakazo-postgres-1 >/dev/null 2>&1 || true
  docker volume rm rakazo_pgdata >/dev/null
  grep -q '^POSTGRES_IMAGE=' .env && sed -i "s|^POSTGRES_IMAGE=.*|POSTGRES_IMAGE=$NEW_IMAGE|" .env || echo "POSTGRES_IMAGE=$NEW_IMAGE" >>.env
  "${COMPOSE[@]}" up -d --no-deps postgres >/dev/null
  for i in $(seq 1 60); do docker exec rakazo-postgres-1 pg_isready -U $PGU >/dev/null 2>&1 && break; sleep 2; done
  restore_into rakazo-postgres-1 "$BK"
  echo "-- verify restored data against the final dump source"
  counts rakazo-postgres-1 >"$BK/new.counts"; shape rakazo-postgres-1 >"$BK/new.shape"
  local bad=0
  diff -q "$BK/old.counts" "$BK/new.counts" >/dev/null && echo "PASS row counts identical ($(wc -l <"$BK/old.counts") tables)" || { echo "FAIL row counts"; diff "$BK/old.counts" "$BK/new.counts" | head; bad=1; }
  diff -q "$BK/old.shape" "$BK/new.shape" >/dev/null && echo "PASS object counts identical" || { echo "FAIL object counts"; diff "$BK/old.shape" "$BK/new.shape"; bad=1; }
  graph_test rakazo-postgres-1 || bad=1
  if [ $bad -ne 0 ]; then echo "VERIFY FAILED: run ops/pgvector-swap.sh rollback $BK"; exit 1; fi
  echo "starting app services"; "${COMPOSE[@]}" up -d --no-build migrate "${APP_SERVICES[@]}" >/dev/null
  echo "$BK" >"$ROOT/backups/pgswap-latest"
  echo "SWAP DONE. rollback: ops/pgvector-swap.sh rollback $BK"
}

rollback() {
  local d=${2:-$(cat "$ROOT/backups/pgswap-latest")}
  "${COMPOSE[@]}" stop "${APP_SERVICES[@]}" postgres >/dev/null; docker rm -f rakazo-postgres-1 >/dev/null 2>&1 || true
  docker volume rm rakazo_pgdata >/dev/null; docker volume create rakazo_pgdata >/dev/null
  docker run --rm -v rakazo_pgdata:/to -v "$d":/from:ro busybox:1 tar xzf /from/pgdata-volume.tgz -C /to
  sed -i "s|^POSTGRES_IMAGE=.*|POSTGRES_IMAGE=$OLD_IMAGE|" .env
  "${COMPOSE[@]}" up -d --no-build postgres migrate "${APP_SERVICES[@]}" >/dev/null
  echo "ROLLED BACK to $OLD_IMAGE using $d"
}

case "${1:-}" in rehearse) rehearse ;; swap) swap ;; rollback) rollback "$@" ;; *) echo "usage: $0 rehearse|swap|rollback [dir]"; exit 1 ;; esac
