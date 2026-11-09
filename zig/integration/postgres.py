#!/usr/bin/env python3
"""Test native libpq/Zig near-head persistence on disposable PostgreSQL16.

Applies the production Rust migrations. Never connects to an existing database.
Docker publishes a random port on loopback; the container is removed on exit.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
_CPU_SPEC = importlib.util.spec_from_file_location("postgres_fixture_cpu", ROOT / "zig/tools/build_cpu.py")
cpu = importlib.util.module_from_spec(_CPU_SPEC)
_CPU_SPEC.loader.exec_module(cpu)


def run(args, *, cwd=ROOT, env=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode:
        print(result.stdout, file=sys.stderr, end="")
        print(result.stderr, file=sys.stderr, end="")
        result.check_returncode()
    return result


def chunks(text):
    return [text[i:i+32] for i in range(0, len(text), 32)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpu-profile", choices=["production-default", "x86_64_v3"], default="production-default")
    parser.add_argument("--compiler", default=os.environ.get("ZIG", "zig"))
    parser.add_argument("--mode", choices=["ReleaseSafe", "ReleaseFast"], default="ReleaseSafe")
    parser.add_argument("--sdk-root", type=Path)
    parser.add_argument("--libpq-library", type=Path, default=Path("/opt/homebrew/opt/libpq/lib/libpq.dylib"))
    parser.add_argument("--image", default="postgres:16")
    parser.add_argument("--process-only", action="store_true", help="Skip Zig compile/test execution; retain fresh Docker, production migrations, explicit SQL smoke and actual scraper process")
    parser.add_argument("--scraper-binary", type=Path, help="Optional actual scraper process integration on this migrated disposable database")
    parser.add_argument("--migration-bin", type=Path, default=ROOT / "rust/main/target/release/init-db")
    parser.add_argument("--rust-toolchain", default="1.98.0")
    parser.add_argument("--output", type=Path, default=ROOT / "zig/bench/results")
    args = parser.parse_args()
    if args.process_only and args.scraper_binary is None:
        parser.error("--process-only requires --scraper-binary")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if not args.process_only and run([args.compiler, "version"]).stdout.strip() != "0.15.2":
        parser.error("Zig0.15.2 required")
    portable = args.cpu_profile == "x86_64_v3"
    if portable and (sys.platform != "linux" or os.uname().machine != "x86_64" or args.migration_bin.resolve() != ROOT / "rust/main/target/release/init-db"):
        parser.error("Portable fixture compilers require Linux x86_64 and their actual Cargo migration output")
    compiler_environment = cpu.portable_environment(os.environ, tokio_unstable=True) if portable else dict(os.environ)
    compiler_recipes = []
    cpu_source = (ROOT / "zig/tools/build_cpu.py").read_bytes() if portable else None
    if portable or not args.migration_bin.exists():
        command = ["cargo", f"+{args.rust_toolchain}", "build", "--locked", "--release", "-p", "migration", "--bin", "init-db", "-j", "2"]
        recipe = cpu.recipe("rust", command, compiler_environment, Path(__file__), repo=ROOT) if portable else None
        built = run(command, cwd=ROOT / "rust/main", env=compiler_environment)
        if recipe is not None:
            if (ROOT / "zig/tools/build_cpu.py").read_bytes() != cpu_source: raise RuntimeError("Portable compiler Source changed")
            compiler_recipes.append(cpu.finish_recipe(recipe, {"actual_parent_wait": True, "exit_code": built.returncode, "error": None}, repo=ROOT))
        (output / "rust-init-db-build.log").write_text(built.stdout + built.stderr)
    name = f"ziggy-pg-fixture-{os.getpid()}"
    started = False
    with tempfile.TemporaryDirectory(prefix="ziggy-pg-tests-") as folder:
        binary = Path(folder) / "postgres-tests"
        build = [args.compiler, "test", "zig/src/pg_tests.zig", "-O", args.mode, "-j2", "-lc", args.libpq_library, "--test-no-exec", f"-femit-bin={binary}"]
        if portable: build += cpu.zig_cpu_args("direct")
        if args.sdk_root:
            build += ["--sysroot", args.sdk_root, "-L/usr/lib"]
        if not args.process_only:
            build = [str(value) for value in build]
            recipe = cpu.recipe("zig-direct", build, compiler_environment, Path(__file__), repo=ROOT) if portable else None
            compiled = run(build, env=compiler_environment)
            if recipe is not None:
                if (ROOT / "zig/tools/build_cpu.py").read_bytes() != cpu_source: raise RuntimeError("Portable compiler Source changed")
                compiler_recipes.append(cpu.finish_recipe(recipe, {"actual_parent_wait": True, "exit_code": compiled.returncode, "error": None}, repo=ROOT))
            (output / "postgres-test-build.log").write_text(compiled.stdout + compiled.stderr)
        try:
            run(["docker", "run", "--detach", "--rm", "--pull=never", "--name", name,
                 "-e", "POSTGRES_USER=ziggy", "-e", "POSTGRES_DB=ziggy",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", "127.0.0.1::5432", args.image])
            started = True
            port_text = run(["docker", "port", name, "5432/tcp"]).stdout.strip()
            host, port = port_text.rsplit(":", 1)
            if host != "127.0.0.1" or not port.isdecimal():
                raise RuntimeError("Docker did not publish only a dynamic loopback port")
            deadline = time.monotonic() + 30
            while True:
                ready = subprocess.run(["docker", "exec", name, "pg_isready", "-U", "ziggy", "-d", "ziggy"], capture_output=True)
                if ready.returncode == 0:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Disposable PostgreSQL did not become ready")
                time.sleep(0.2)
            env = dict(os.environ)
            env["DATABASE_URL"] = f"postgresql://ziggy@127.0.0.1:{port}/ziggy?sslmode=disable"
            migrated = run([args.migration_bin], env=env)
            (output / "postgres-migrations.log").write_text(migrated.stdout + migrated.stderr)
            env["ZIGGY_PG_FIXTURE"] = f"host=127.0.0.1 port={port} dbname=ziggy user=ziggy connect_timeout=5 sslmode=disable"
            # These server-side checks are separate from the native libpq suite.
            # A process-only run must never inherit its eleven functional claims.
            smoke_sql = """
BEGIN;
SET LOCAL statement_timeout='5s';
DO $$ BEGIN
 IF (SELECT count(*) FROM seaql_migrations) <> 21 THEN RAISE EXCEPTION 'expected21 production migrations'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['domain','message','raw_message_dispatch','delivered_message','gas_payment','merkle_tree_insertion','scraper_head','confirmed_raw_message_dispatch','confirmed_delivered_message','confirmed_gas_payment','confirmed_merkle_tree_insertion']) AS names(name) WHERE to_regclass(name) IS NULL) THEN RAISE EXCEPTION 'missing source schema relation'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_name='scraper_head' AND column_name IN ('writer_id','writer_lease_until','confirmed_height'))<>3 THEN RAISE EXCEPTION 'missing source writer/frontier fields'; END IF;
END $$;
CREATE TEMP TABLE ziggy_fixture_sql_smoke(domain integer, value bytea, nullable text);
INSERT INTO ziggy_fixture_sql_smoke VALUES(-1,decode('00ff','hex'),NULL);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ziggy_fixture_sql_smoke WHERE domain=-1 AND encode(value,'hex')='00ff' AND nullable IS NULL) THEN RAISE EXCEPTION 'SQL value mismatch'; END IF;
 IF NOT pg_try_advisory_xact_lock(2147483000) THEN RAISE EXCEPTION 'fresh fixture lock unexpectedly held'; END IF;
 IF clock_timestamp() IS NULL THEN RAISE EXCEPTION 'database clock absent'; END IF;
END $$;
ROLLBACK;
SELECT to_regclass('pg_temp.ziggy_fixture_sql_smoke') IS NULL;
"""
            smoke = run(["docker", "exec", name, "psql", "-U", "ziggy", "-d", "ziggy", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", smoke_sql])
            if smoke.stdout.strip() != "t":
                raise RuntimeError("Disposable SQL rollback smoke did not confirm cleanup")
            (output / "postgres-sql-smoke.log").write_text(smoke.stdout + smoke.stderr)
            sql_cases = ["actual21 production migration records", "source event tables confirmed views and writer/frontier fields", "SQL binary NULL signed-integer values", "transaction advisory lock and database clock", "rollback removes all temporary smoke state"]
            native_tests = {"executed": not args.process_only, "passed": None, "reason": "explicit process-only; native tests neither compiled nor executed" if args.process_only else None}
            if not args.process_only:
                tested = subprocess.run([str(binary)], cwd=ROOT, env=env, text=True, capture_output=True)
                log = tested.stdout + tested.stderr
                (output / "postgres-integration.log").write_text(log)
                native_tests["passed"] = tested.returncode == 0
                native_tests["exit_code"] = tested.returncode
                (output / "postgres-native-tests.json").write_text(json.dumps(native_tests, indent=2) + "\n")
                if tested.returncode:
                    print(log, file=sys.stderr, end="")
                    tested.check_returncode()
            else:
                (output / "postgres-native-tests.json").write_text(json.dumps(native_tests, indent=2) + "\n")
            if args.scraper_binary:
                process = run([sys.executable, ROOT / "zig/integration/scraper_process.py",
                               "--binary", args.scraper_binary.resolve(), "--container", name,
                               "--conninfo", env["ZIGGY_PG_FIXTURE"], "--port", port,
                               "--output", output / "scraper-process.json"],
                              env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                                   **{name: os.environ[name] for name in ("DOCKER_HOST", "DOCKER_CONFIG") if name in os.environ}})
                (output / "scraper-process.log").write_text(process.stdout + process.stderr)
            version = run(["docker", "exec", name, "postgres", "--version"]).stdout.strip()
            image_id = run(["docker", "inspect", "--format", "{{.Image}}", name]).stdout.strip()
            schemas = run(["docker", "exec", name, "psql", "-U", "ziggy", "-d", "ziggy", "-At", "-c", "SELECT count(*) FROM seaql_migrations"]).stdout.strip()
            source_files = ["zig/src/db/postgres.zig", "zig/src/db/scraper_store.zig", "zig/src/db/postgres_test.zig",
                            "rust/main/agents/scraper/src/near_head/store.rs", "rust/main/agents/scraper/src/near_head/store/batch.rs"]
            hashes = {path: chunks(hashlib.sha256((ROOT / path).read_bytes()).hexdigest()) for path in source_files}
            result = {
                "passed": True, "scope": "actual scraper process and explicit server-side SQL smoke on fresh production migrations; native tests not run" if args.process_only else "native libpq and near-head PostgreSQL persistence on actual Rust migrations; not a whole-agent replay",
                "compiler_CPU_profile": cpu.PROFILE if portable else "production-default", "compiler_recipes": compiler_recipes,
                "mode": "process-only" if args.process_only else "native-and-optional-process", "native_tests": native_tests, "sql_smoke_cases": sql_cases,
                "server": version, "client_library": str(args.libpq_library), "docker_image": args.image,
                "docker_image_digest_chunks": chunks(image_id.removeprefix("sha256:")),
                "production_migrations_applied": int(schemas), "zig_optimize": None if args.process_only else args.mode,
                "functional_cases": sql_cases if args.process_only else ["parameterized text/binary/null values and result ownership", "aborted transaction rollback and SQLSTATE",
                                     "four staged event streams and confirmed frontier views", "gas cursor publication",
                                     "atomic append failure", "reorg suffix rollback and confirmed-boundary protection",
                                     "expired confirmation rollback", "database-clock writer takeover", "advisory transaction locking",
                                     "1000-row batches and oversized-block atomic publication", "u32 domain INTEGER bitcast compatibility"],
                "source_sha256_chunks": hashes,
                "isolation": "task-owned Docker container; fresh database; dynamic loopback-only port; removed in finally",
            }
            (output / "postgres-integration.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps({"passed": True, "server": version, "migrations": int(schemas), "functional_cases": len(result["functional_cases"])}))
        finally:
            if started:
                run(["docker", "stop", "--time", "5", name])


if __name__ == "__main__":
    main()
