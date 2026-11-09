#!/usr/bin/env python3
"""Build/discover exact production RocksDB native archives without Rust agents.

Python3.11+, Cargo/rustc1.98.0, C/C++17 compiler, ar and libclang are build
requirements. This does not link the build-only Rust crates into Zig agents.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shlex
import signal
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "zig/native/rocks"
_CPU_SPEC = importlib.util.spec_from_file_location("native_dependency_cpu", ROOT / "zig/tools/build_cpu.py")
cpu = importlib.util.module_from_spec(_CPU_SPEC)
_CPU_SPEC.loader.exec_module(cpu)
NATIVE = {"librocksdb-sys": ["librocksdb.a", "libsnappy.a"],
          "lz4-sys": ["liblz4.a"], "zstd-sys": ["libzstd.a"],
          "libz-sys": ["libz.a"], "bzip2-sys": ["libbz2.a"]}
FEATURES = {"bindgen-runtime", "bzip2", "bzip2-sys", "libz-sys",
            "lz4", "lz4-sys", "snappy", "static", "zlib", "zstd", "zstd-sys"}
EXPECTED_RUNTIME = {"abi_version": 1, "rocksdb": "10.4.2", "zlib": "1.3.1",
                    "lz4": 10904, "zstd": 10506, "bzip2": "1.0.8, 13-Jul-2019",
                    "codecs_reopened": [0, 1, 2, 3, 4, 5, 7]}


def chunks(text: str) -> list[str]:
    return [text[i:i + 31] for i in range(0, len(text), 31)]


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(part)
    return result.hexdigest()


def restore_lock() -> tuple[dict, dict]:
    record = json.loads((PROJECT / "lock.json").read_text())
    if record.get("schema") != 1:
        raise ValueError("Unsupported native lock schema")
    wire = "".join(record["utf8_chunks"]).encode()
    if hashlib.sha256(wire).hexdigest() != "".join(record["sha256_chunks"]):
        raise ValueError("Native dependency lock checksum mismatch")
    locked = tomllib.loads(wire.decode())
    production = tomllib.loads((ROOT / "rust/main/Cargo.lock").read_text())
    registry = {(p["name"], p["version"]): p for p in production["package"]}
    pins = {}
    for package in locked["package"]:
        if "source" not in package:
            if package["name"] != "ziggy-native-rocks-build":
                raise ValueError("Unexpected local dependency in native lock")
            continue
        expected = registry.get((package["name"], package["version"]))
        if expected is None or any(package.get(k) != expected.get(k) for k in ["source", "checksum"]):
            raise ValueError(f"Native pin differs from production: {package['name']}")
        pins[package["name"] + "@" + package["version"]] = package
    if pins["librocksdb-sys@0.17.3+10.4.2"]["version"] != "0.17.3+10.4.2":
        raise ValueError("Unexpected production RocksDB engine")
    rocks = registry.get(("rocksdb", "0.24.0"))
    if rocks is None or "librocksdb-sys" not in rocks["dependencies"]:
        raise ValueError("Production rocksdb wrapper/version changed")
    # Generated Cargo.lock is ignored; reviewable checksum chunks are committed.
    destination = PROJECT / "Cargo.lock"
    if not destination.exists() or destination.read_bytes() != wire:
        destination.write_bytes(wire)
    return pins, record


def cargo_metadata(toolchain: str, offline: bool) -> dict:
    command = ["cargo", f"+{toolchain}", "metadata", "--locked", "--format-version", "1",
               "--manifest-path", str(PROJECT / "Cargo.toml")]
    if offline:
        command.append("--offline")
    return json.loads(subprocess.check_output(command, cwd=PROJECT, timeout=180))


def verify_sources(metadata: dict, pins: dict) -> dict:
    sources = {}
    nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
    for package in metadata["packages"]:
        if package["source"] is None:
            continue
        pin = pins.get(package["name"] + "@" + package["version"])
        if pin is None or package["version"] != pin["version"]:
            raise ValueError(f"Cargo resolved outside production closure: {package['name']}@{package['version']}")
        source = Path(package["manifest_path"]).resolve().parent
        archive = source.parents[2] / "cache" / source.parent.name / (source.name + ".crate")
        if not archive.is_file() or digest(archive) != pin["checksum"]:
            raise ValueError(f"Pinned registry source archive unavailable/mismatched: {package['name']}")
        expanded = 0
        expected_files = set()
        # Verify actual compiler inputs against the checksum-pinned .crate,
        # including registry caches lacking the older .cargo-checksum.json.
        with tarfile.open(archive, "r|gz") as tar:
            for member in tar:
                if member.isdir():
                    continue
                relative = Path(member.name)
                if not member.isfile() or relative.parts[0] != source.name or ".." in relative.parts:
                    raise ValueError("Unsafe pinned source archive member")
                file = source.joinpath(*relative.parts[1:])
                expected_files.add(file.relative_to(source).as_posix())
                expanded += member.size
                if expanded > 1024 ** 3 or file.is_symlink() or not file.resolve().is_relative_to(source):
                    raise ValueError("Unsafe source file or expanded package bound")
                content = tar.extractfile(member)
                expected_hash = hashlib.sha256()
                for part in iter(lambda: content.read(1024 * 1024), b""):
                    expected_hash.update(part)
                if digest(file) != expected_hash.hexdigest():
                    raise ValueError(f"Registry source file checksum mismatch: {member.name}")
        for file in source.rglob("*"):
            if file.is_symlink():
                raise ValueError(f"Unexpected registry source symlink: {file}")
            if file.is_file() and file.relative_to(source).as_posix() not in expected_files | {".cargo-ok", ".cargo-checksum.json"}:
                raise ValueError(f"Unexpected unpinned registry source file: {file}")
        if package["name"] == "librocksdb-sys" and set(nodes[package["id"]]["features"]) != FEATURES:
            raise ValueError("Native RocksDB features differ from production defaults")
        sources[package["name"] + "@" + package["version"]] = {"name": package["name"], "path": source, "version": package["version"],
            "checksum": pin["checksum"], "license": package["license"],
            "features": nodes[package["id"]]["features"]}
    if not all(any(s["name"] == name for s in sources.values()) for name in NATIVE):
        raise ValueError("Missing native source dependency")
    return sources


def source_for(sources: dict, name: str) -> dict:
    values = [s for s in sources.values() if s["name"] == name]
    if len(values) != 1:
        raise ValueError(f"Ambiguous native source: {name}")
    return values[0]


def build_environment(sdk: Path | None, deployment: str | None = None, cpu_profile: str = "production-default") -> dict:
    env = os.environ.copy()
    # Never let a developer's system-library override substitute another engine
    # or compression build for the pinned bundled sources.
    prefixes = ("ROCKSDB_", "SNAPPY_", "LZ4_", "ZSTD_", "BZIP2_", "LIBZ_")
    for key in list(env):
        if key.startswith(prefixes) or key.startswith(("CARGO_PROFILE_", "CFLAGS", "CXXFLAGS", "ARFLAGS", "HOST_CFLAGS", "HOST_CXXFLAGS", "TARGET_CFLAGS", "TARGET_CXXFLAGS", "CC_", "CXX_", "AR_", "HOST_CC", "HOST_CXX", "TARGET_CC", "TARGET_CXX")) or key in {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"}:
            env.pop(key)
    env.update(ROCKSDB_COMPILE="1", SNAPPY_COMPILE="1", LIBZ_SYS_STATIC="1", SOURCE_DATE_EPOCH="0", ZERO_AR_DATE="1")
    if platform.system() == "Darwin" and deployment:
        env["MACOSX_DEPLOYMENT_TARGET"] = deployment
    if sdk:
        if platform.system() != "Darwin" or not (sdk / "usr/include").is_dir():
            raise ValueError("--sdk-root must name an installed macOS SDK")
        env["SDKROOT"] = str(sdk)
        env["BINDGEN_EXTRA_CLANG_ARGS"] = "-isysroot " + shlex.quote(str(sdk))
    if cpu_profile == "x86_64_v3_pclmul":
        if platform.system() != "Linux" or platform.machine() != "x86_64":
            raise ValueError("Portable native dependencies require Linux x86_64")
        env = cpu.portable_environment(env)
    elif cpu_profile != "production-default":
        raise ValueError("Unknown native dependency CPU profile")
    return env


def build_native(args, output: Path) -> tuple[dict, dict]:
    log = output / "cargo-messages.jsonl"
    diagnostics = output / "cargo-build.log"
    command = ["cargo", f"+{args.toolchain}", "build", "--locked", "--release",
        "--manifest-path", str(PROJECT / "Cargo.toml"), "--target-dir", str(args.target_dir),
        "--jobs", str(args.jobs), "--message-format=json-render-diagnostics"]
    if args.offline:
        command.append("--offline")
    environment = build_environment(args.sdk_root, args.macos_deployment_target, args.cpu_profile)
    recipe = cpu.recipe("rust", command, environment, Path(__file__), repo=ROOT) if args.cpu_profile == "x86_64_v3_pclmul" else None
    start = time.monotonic()
    with log.open("w") as stdout, diagnostics.open("w") as stderr:
        process = subprocess.Popen(command, cwd=PROJECT, env=environment,
            stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            returncode = process.wait(timeout=args.build_timeout)
        except BaseException:
            # Cargo owns compiler children; terminate the entire task-owned
            # process group on deadline/interruption rather than orphan C++ jobs.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
    if returncode:
        raise RuntimeError(f"Native dependency build failed; see {diagnostics}")
    dirs, compiled, complete = {}, set(), False
    for line in log.read_text().splitlines():
        event = json.loads(line)
        if event["reason"] == "build-finished":
            complete = event["success"]
        if event["reason"] == "compiler-artifact":
            compiled.add(event["package_id"])
        if event["reason"] != "build-script-executed":
            continue
        name = event["package_id"].rsplit("#", 1)[-1].split("@", 1)[0]
        if name in NATIVE:
            path = Path(event["out_dir"]).resolve()
            if not path.is_relative_to(args.target_dir.resolve()):
                raise ValueError("Cargo native artifact escaped the selected target")
            dirs[name] = path
    if not complete or dirs.keys() != NATIVE.keys():
        raise ValueError("Cargo did not report every required native build output")
    completed_recipe = cpu.finish_recipe(recipe, {"actual_parent_wait": True, "exit_code": returncode, "error": None}, repo=ROOT) if recipe is not None else None
    build = {"mode": "standalone-cargo-build", "elapsed_seconds": round(time.monotonic() - start, 3),
             "command": command, "compiled_package_count": len(compiled),
             "compiled_package_ids": sorted(compiled), "diagnostics": str(diagnostics)}
    if completed_recipe is not None: build["cpu_recipe"] = completed_recipe
    return dirs, build


def archive_magic(path: Path) -> bytes:
    with path.open("rb") as stream:
        return stream.read(8)


def atomic_copy(source: Path, destination: Path) -> None:
    with tempfile.NamedTemporaryFile(prefix=".native-copy-", dir=destination.parent, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        shutil.copyfile(source, temporary)
        # Public build archives must remain readable by the nonroot fixture compiler.
        temporary.chmod(0o644)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def find_archive(directory: Path, name: str) -> Path:
    matches = [p for p in directory.rglob(name) if p.is_file() and not p.is_symlink()]
    if not matches:
        raise ValueError(f"Missing {name} in native output")
    # libz-sys may retain an installed copy as well as its build copy.
    matches.sort(key=lambda p: (len(p.parts), str(p)))
    selected = matches[0]
    if selected.stat().st_size > 4 * 1024 ** 3 or archive_magic(selected) != b"!<arch>\n":
        raise ValueError(f"Not a bounded native static archive: {selected}")
    return selected


def import_target(target: Path, sources: dict) -> tuple[dict, dict]:
    """Read-only reuse, correlated to Cargo depfile/fingerprint source identity."""
    target = target.resolve()
    candidates = []
    for file in (target / "release/deps").glob("librocksdb_sys-*.d"):
        hash_id = file.stem.removeprefix("librocksdb_sys-")
        fingerprint = target / "release/.fingerprint" / ("librocksdb-sys-" + hash_id) / "lib-librocksdb_sys.json"
        if not fingerprint.is_file():
            continue
        if set(json.loads(json.loads(fingerprint.read_text())["features"])) != FEATURES:
            continue
        # Make depfiles escape spaces. shlex retains escaped source-path spaces.
        paths = shlex.split(file.read_text().splitlines()[0])
        expected_source = source_for(sources, "librocksdb-sys")["path"] / "src/lib.rs"
        if str(expected_source) not in paths:
            continue
        for text in paths:
            path = Path(text)
            if path.name == "bindings.rs" and path.parent.is_relative_to(target) and (path.parent / "librocksdb.a").is_file():
                candidates.append(path.parent)
    if not candidates:
        raise ValueError("Rust target has no matching production source/features fingerprint")
    candidates.sort(key=lambda p: (p / "librocksdb.a").stat().st_mtime_ns, reverse=True)
    dirs = {"librocksdb-sys": candidates[0]}
    for name, libraries in NATIVE.items():
        if name == "librocksdb-sys":
            continue
        crate = name.replace("-", "_")
        version_source = source_for(sources, name)["path"]
        # Require a compiled Rust sys crate naming the exact pinned source.
        if not any(str(version_source) in p.read_text() for p in (target / "release/deps").glob(crate + "-*.d")):
            raise ValueError(f"Rust target lacks pinned source provenance: {name}")
        choices = []
        for directory in (target / "release/build").glob(name + "-*/out"):
            try:
                archive = find_archive(directory, libraries[0])
                choices.append((archive.stat().st_mtime_ns, directory))
            except ValueError:
                pass
        if not choices:
            raise ValueError(f"Rust target lacks compression archive: {name}")
        dirs[name] = max(choices)[1]
    return dirs, {"mode": "explicit-read-only-rust-target-import", "target": str(target),
        "original_compiler_flags_reproduced": False,
        "validation": "pinned Cargo sources/features, native runtime versions and all codec reopen probe"}


def native_flags(sdk: Path | None, cpu_profile: str = "production-default") -> tuple[list[str], list[str]]:
    if platform.system() == "Darwin":
        return (["-isysroot", str(sdk)] if sdk else []), ["-lc++", "-lpthread"]
    if platform.system() == "Linux":
        flags = []
        if cpu_profile == "x86_64_v3_pclmul":
            if platform.machine() != "x86_64":
                raise ValueError("Portable native C/C++ requires Linux x86_64")
            flags = shlex.split(cpu.portable_environment({})["CXXFLAGS"])
        elif cpu_profile != "production-default":
            raise ValueError("Unknown native dependency CPU profile")
        return flags, ["-lstdc++", "-lpthread", "-ldl", "-lm"]
    raise ValueError("Native bootstrap supports macOS and Linux only")


def compile_shim_and_probe(args, output: Path, archives: list[Path], sources: dict, recipes: list | None = None) -> tuple[Path, dict]:
    compiler = shlex.split(args.cxx)
    archiver = shlex.split(args.ar)
    flags, system = native_flags(args.sdk_root, args.cpu_profile)
    include = source_for(sources, "librocksdb-sys")["path"] / "rocksdb/include"
    object_file = output / "abi.o"
    shim = output / "libziggy_rocks_abi.a"
    if platform.system() == "Darwin":
        flags += ["-mmacosx-version-min=" + args.macos_deployment_target]
    common = compiler + ["-std=c++17", "-O2", "-fPIC", "-DNDEBUG", "-I", str(include), "-I", str(PROJECT)] + flags
    environment = build_environment(args.sdk_root, args.macos_deployment_target, args.cpu_profile)
    command = common + ["-c", str(PROJECT / "abi.cc"), "-o", str(object_file)]
    recipe = cpu.recipe("cc", command, environment, Path(__file__), repo=ROOT) if args.cpu_profile == "x86_64_v3_pclmul" else None
    completed = subprocess.run(command, check=True, timeout=120, env=environment)
    if recipe is not None:
        if recipes is None: raise ValueError("Portable dependency recipe collector required")
        recipes.append(cpu.finish_recipe(recipe, {"actual_parent_wait": True, "exit_code": completed.returncode, "error": None}, repo=ROOT))
    # Replace rather than append to a previous archive, preserving one shim object.
    with tempfile.TemporaryDirectory(prefix="abi-archive-", dir=output) as temporary:
        temporary_archive = Path(temporary) / shim.name
        subprocess.run(archiver + ["crs", str(temporary_archive), str(object_file)], check=True, timeout=60, env=environment)
        temporary_archive.replace(shim)
    probe = output / "native-probe"
    link_system = [flag for flag in system if flag not in {"-lc++", "-lstdc++"}]
    command = common + [str(PROJECT / "probe.cc"), str(shim), *map(str, archives), *link_system, "-o", str(probe)]
    recipe = cpu.recipe("cc", command, environment, Path(__file__), repo=ROOT) if args.cpu_profile == "x86_64_v3_pclmul" else None
    with (output / "native-probe-build.log").open("w") as diagnostics:
        completed = subprocess.run(command, check=True, timeout=180, stdout=diagnostics, stderr=diagnostics, env=environment)
    if recipe is not None:
        recipes.append(cpu.finish_recipe(recipe, {"actual_parent_wait": True, "exit_code": completed.returncode, "error": None}, repo=ROOT))
    with tempfile.TemporaryDirectory(prefix="native-probe-db-", dir=output) as database:
        result = json.loads(subprocess.check_output([str(probe), database], timeout=90))
    if result != EXPECTED_RUNTIME:
        raise ValueError(f"Linked native runtime/codec versions differ from pinned sources: {result}")
    return shim, result


def preserve_licenses(sources: dict, output: Path) -> list[dict]:
    preserved = []
    for _, source in sorted(sources.items()):
        name = source["name"]
        base = source["path"]
        for file in sorted(base.rglob("*")):
            if not file.is_file() or file.is_symlink() or not file.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE", "COPYRIGHT", "AUTHORS")):
                continue
            relative = Path("licenses") / (name + "-" + source["version"]) / file.relative_to(base)
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, destination)
            preserved.append({"path": str(relative), "sha256_chunks": chunks(digest(destination))})
    return preserved


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", default="1.98.0")
    parser.add_argument("--cpu-profile", choices=["production-default", "x86_64_v3_pclmul"], default="production-default")
    parser.add_argument("--cpu-recipe-directory", type=Path, help="Optional fresh build-only recipe directory; not added to published archive inventory")
    parser.add_argument("--git-sha", help="Actual producer commit required for portable CPU receipts")
    parser.add_argument("--target-dir", type=Path, default=PROJECT / "target")
    parser.add_argument("--output", type=Path, default=PROJECT / "out")
    parser.add_argument("--from-rust-target", type=Path, help="Read-only import of matching release artifacts; never builds agents")
    parser.add_argument("--sdk-root", type=Path, help="Explicit macOS SDK used for source build, shim and probe")
    parser.add_argument("--macos-deployment-target", default="11.0", help="Explicit minimum native macOS version (default11.0)")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 4))
    parser.add_argument("--build-timeout", type=int, default=3600)
    parser.add_argument("--cxx", default=os.environ.get("CXX", "c++"))
    parser.add_argument("--ar", default=os.environ.get("AR", "ar"))
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--restore-only", action="store_true")
    parser.add_argument("--format", choices=["json", "libs", "zig-args"], default="json")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 64 or args.build_timeout < 1:
        parser.error("jobs must be1..64 and build timeout positive")
    if platform.system() not in {"Darwin", "Linux"}:
        parser.error("only macOS/Linux hosts are supported")
    if platform.machine() not in {"arm64", "aarch64", "x86_64", "AMD64"}:
        parser.error("only native aarch64/x86_64 hosts are supported")
    args.target_dir = args.target_dir.resolve()
    args.output = args.output.resolve()
    if args.sdk_root:
        args.sdk_root = args.sdk_root.resolve()
    subprocess.run(["python3", "zig/tools/fixture_pack.py", "restore-locks"], check=True, cwd=ROOT)
    pins, lock = restore_lock()
    cpu_source_before = Path(cpu.__file__).read_bytes()
    if args.restore_only:
        print(PROJECT / "Cargo.lock")
        return 0
    args.output.mkdir(parents=True, exist_ok=True)
    metadata = cargo_metadata(args.toolchain, args.offline)
    sources = verify_sources(metadata, pins)
    if args.cpu_recipe_directory is not None and args.cpu_profile != "x86_64_v3_pclmul":
        raise ValueError("Recipe directory requires the explicit portable profile")
    if args.cpu_profile == "x86_64_v3_pclmul" and (args.from_rust_target or not args.git_sha or re.fullmatch("[0-9a-f]{40}", args.git_sha) is None):
        raise ValueError("Portable native dependencies require a fresh build and actual producer commit")
    dirs, build = import_target(args.from_rust_target, sources) if args.from_rust_target else build_native(args, args.output)
    recipes = [build.pop("cpu_recipe")] if args.cpu_profile == "x86_64_v3_pclmul" else []
    archives = []
    archive_records = []
    for name, libraries in NATIVE.items():
        for library in libraries:
            original = find_archive(dirs[name], library)
            destination = args.output / library
            if original.resolve() != destination.resolve():
                atomic_copy(original, destination)
            archives.append(destination)
            archive_records.append({"path": str(destination), "source": str(original), "package": name,
                "size_bytes": destination.stat().st_size, "sha256_chunks": chunks(digest(destination))})
    shim, runtime = compile_shim_and_probe(args, args.output, archives, sources, recipes)
    archives.insert(0, shim)
    archive_records.insert(0, {"path": str(shim), "package": "ziggy-version-only-c-abi",
        "size_bytes": shim.stat().st_size, "sha256_chunks": chunks(digest(shim))})
    licenses = preserve_licenses(sources, args.output)
    _, system = native_flags(args.sdk_root, args.cpu_profile)
    native_libraries = ",".join(map(str, archives))
    if any("," in str(path) for path in archives):
        raise ValueError("Archive paths containing commas cannot be used by native-db-libs")
    manifest = {"schema": 1, "host": {"system": platform.system(), "architecture": platform.machine()},
        "sdk_root": str(args.sdk_root) if args.sdk_root else None,
        "source_date_epoch": None if args.from_rust_target else "0",
        "shim_source_date_epoch": "0",
        "macos_deployment_target": args.macos_deployment_target if platform.system() == "Darwin" else None,
        "source": "production Rust rocksdb0.24.0/librocksdb-sys0.17.3+10.4.2 default features",
        "production_lock_sha256_chunks": chunks(digest(ROOT / "rust/main/Cargo.lock")),
        "native_lock_sha256_chunks": lock["sha256_chunks"], "rocksdb_features": sorted(FEATURES),
        "archives": archive_records, "native_db_libs": native_libraries,
        "zig_build_args": ["-Dnative-db-libs=" + native_libraries], "system_link_args": system,
        "native_runtime_probe": runtime, "build": build, "licenses": licenses,
        "compiler": {"cxx": shlex.split(args.cxx), "version": subprocess.check_output(shlex.split(args.cxx) + ["--version"], text=True, timeout=15).strip()},
        "abi_source_sha256_chunks": {name: chunks(digest(PROJECT / name)) for name in ["abi.cc", "abi.h", "abi.zig", "probe.cc"]},
        "dependency_boundary": {"native_runtime_components": ["RocksDB", "Snappy", "LZ4", "Zstd", "zlib", "bzip2", "system C/C++ runtimes"],
            "rust_runtime_linked": False, "rust_agent_logic_linked": False,
            "rust_build_source_package_count": len(sources),
            "build_requirements": ["Python3.11+", "Cargo/rustc" + args.toolchain, "C/C++17 compiler", "ar", "libclang", "platform SDK/system headers"]},
        "source_packages": [{"name": info["name"], "version": info["version"], "license": info["license"],
            "sha256_chunks": chunks(info["checksum"]), "features": info["features"]} for name, info in sorted(sources.items())]}
    if args.cpu_profile == "x86_64_v3_pclmul":
        if Path(cpu.__file__).read_bytes() != cpu_source_before: raise ValueError("CPU compiler procedure changed")
        if args.cpu_recipe_directory is not None:
            recipe_directory = args.cpu_recipe_directory
            if not recipe_directory.is_absolute() or recipe_directory.exists() or recipe_directory.is_symlink():
                raise ValueError("Fresh absolute build-only CPU recipe directory required")
            recipe_directory.mkdir(parents=True, exist_ok=False)
            for index, recipe in enumerate(recipes):
                with (recipe_directory / (str(index) + ".json")).open("x") as stream: json.dump(recipe, stream)
        manifest["cpu_contract"] = cpu.make_record("native-deps", "shared", args.git_sha, "amd64", cpu.cpu_flags(Path("/proc/cpuinfo").read_text()), {Path(row["path"]).name: {"bytes": row["size_bytes"], "sha256": "".join(row["sha256_chunks"])} for row in archive_records}, recipes)
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.format == "libs":
        print(native_libraries)
    elif args.format == "zig-args":
        print(shlex.join(manifest["zig_build_args"]))
    else:
        print(json.dumps(manifest, indent=2))
    return 0


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("native-deps: interrupted; native build workers terminated", file=sys.stderr)
        raise SystemExit(130)
    except (ValueError, RuntimeError, subprocess.SubprocessError, OSError, tarfile.TarError) as error:
        print(f"native-deps: {error}", file=sys.stderr)
        raise SystemExit(1)
