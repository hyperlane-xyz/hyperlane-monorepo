#!/usr/bin/env python3
"""`docker` PATH shim used by the scraper harness on Depot.

Transparent except for three things, all aimed at measurement, not behaviour:
  * `docker run`: pins the container to $BENCH_FIXTURE_CPUS (--cpuset-cpus) and
    preloads pg_stat_statements so per-database query counts can be read.
  * `docker exec <c> psql -U ziggy ...` (the harness's own verification SQL) is
    run as role `harness`, so agent queries (role `ziggy`) are separable.
  * `docker stop <c>`: before stopping, dumps pg_stat_statements grouped by
    database/role to $BENCH_PGSTAT_OUT.
Real docker binary: $BENCH_REAL_DOCKER.
"""
import json
import os
import subprocess
import sys

REAL = os.environ["BENCH_REAL_DOCKER"]
CPUS = os.environ.get("BENCH_FIXTURE_CPUS")
OUT = os.environ.get("BENCH_PGSTAT_OUT")
ROLE_FLAG = os.environ.get("BENCH_PGSTAT_ROLE_FLAG")
PG_ARGS = ["-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track=top",
           "-c", "pg_stat_statements.max=10000", "-c", "track_activity_query_size=4096"]


def real(argv, **kw):
    return subprocess.run([REAL, *argv], **kw)


def psql(container, sql):
    return real(["exec", container, "psql", "-X", "-U", "ziggy", "-d", "ziggy", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
                capture_output=True, text=True)


def ensure_role(container):
    if not ROLE_FLAG or os.path.exists(ROLE_FLAG + "." + container):
        return
    done = psql(container, "DO $$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='harness') "
                           "THEN CREATE ROLE harness SUPERUSER LOGIN; END IF; END$$")
    if done.returncode == 0:
        open(ROLE_FLAG + "." + container, "w").close()


def dump(container):
    if not OUT:
        return
    psql(container, "CREATE EXTENSION IF NOT EXISTS pg_stat_statements")
    grouped = psql(container, "SELECT coalesce(json_agg(t),'[]') FROM (SELECT d.datname AS database, r.rolname AS role, "
                              "sum(s.calls)::bigint AS calls, sum(s.rows)::bigint AS rows, round(sum(s.total_exec_time)::numeric,3) AS exec_ms, "
                              "count(*) AS statements FROM pg_stat_statements s JOIN pg_database d ON d.oid=s.dbid "
                              "JOIN pg_roles r ON r.oid=s.userid GROUP BY 1,2 ORDER BY 1,2) t")
    top = psql(container, "SELECT coalesce(json_agg(t),'[]') FROM (SELECT d.datname AS database, s.calls, s.rows, "
                          "round(s.total_exec_time::numeric,3) AS exec_ms, left(regexp_replace(s.query,'\\s+',' ','g'),300) AS query, "
                          "row_number() OVER (PARTITION BY d.datname ORDER BY s.calls DESC) AS rank "
                          "FROM pg_stat_statements s JOIN pg_database d ON d.oid=s.dbid JOIN pg_roles r ON r.oid=s.userid "
                          "WHERE r.rolname='ziggy' AND d.datname LIKE 'bench_%') t WHERE rank<=25")
    result = {"grouped": None, "top_agent_statements": None, "errors": []}
    for key, proc in (("grouped", grouped), ("top_agent_statements", top)):
        if proc.returncode == 0 and proc.stdout.strip():
            result[key] = json.loads(proc.stdout)
        else:
            result["errors"].append(proc.stderr[-2000:])
    with open(OUT, "w") as f:
        json.dump(result, f, indent=1)


def main():
    argv = sys.argv[1:]
    if argv[:1] == ["run"]:
        rest = argv[1:]
        if CPUS:
            rest = [f"--cpuset-cpus={CPUS}", *rest]
        image_like = [a for a in rest if a.startswith("postgres:")]
        if image_like:
            rest = [*rest, *PG_ARGS]
        os.execv(REAL, [REAL, "run", *rest])
    if argv[:1] == ["exec"] and "psql" in argv:
        container = argv[1]
        ensure_role(container)
        i = argv.index("psql")
        tail = argv[i + 1:]
        for j in range(len(tail) - 1):
            if tail[j] == "-U" and tail[j + 1] == "ziggy":
                tail[j + 1] = "harness"
        os.execv(REAL, [REAL, *argv[:i + 1], *tail])
    if argv[:1] == ["stop"]:
        container = argv[-1]
        try:
            dump(container)
        except Exception as error:  # measurement only; never block teardown
            print(f"docker shim: pg_stat dump failed: {error}", file=sys.stderr)
    os.execv(REAL, [REAL, *argv])


if __name__ == "__main__":
    main()
