# Postgres 16 with pgvector (from the base image) and Apache AGE (openCypher graphs), same Debian 13 as postgres:16.
FROM pgvector/pgvector:pg16-trixie
ARG AGE_REF=release/PG16/1.6.0
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential git ca-certificates flex bison postgresql-server-dev-16 libreadline-dev zlib1g-dev; \
    git clone --depth 1 --branch "$AGE_REF" https://github.com/apache/age.git /tmp/age; \
    make -C /tmp/age -j2 PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config; \
    make -C /tmp/age install PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config; \
    rm -rf /tmp/age; \
    apt-get purge -y --auto-remove build-essential git flex bison postgresql-server-dev-16 libreadline-dev zlib1g-dev; \
    rm -rf /var/lib/apt/lists/*; \
    ls /usr/share/postgresql/16/extension/age.control /usr/share/postgresql/16/extension/vector.control
# AGE's cypher() parser hook needs the library loaded in every session
CMD ["postgres", "-c", "session_preload_libraries=age"]
