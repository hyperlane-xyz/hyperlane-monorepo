#!/usr/bin/env python3
"""Run the pinned Zig compiler; optionally select a task-local macOS SDK.

Zig 0.15.2 bootstraps its build runner before passing --sysroot to the build.
Its SDK discovery invokes `xcrun --sdk macosx --show-sdk-path`, ignoring SDKROOT.
The scoped shim below selects the explicit SDK for that lookup only. No system
SDK symlinks, compiler files, or user environment files are changed.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import platform
import shutil
import shlex
import subprocess
import tempfile


def gnu_runtime_library(name, variable):
    explicit = os.environ.get(variable)
    if explicit:
        path = Path(explicit).resolve(strict=True)
    else:
        command = shlex.split(os.environ.get("CXX", "c++"))
        if not command:
            raise RuntimeError("CXX must name the native GNU-compatible C++ compiler")
        found = subprocess.check_output([*command, "-print-file-name=" + name], text=True, timeout=30).strip()
        if not found or found == name:
            raise RuntimeError(f"GNU {name} not found; set {variable}")
        path = Path(found).resolve(strict=True)
    if not path.is_file():
        raise RuntimeError(f"GNU {name} must be a regular shared library")
    with path.open("rb") as stream:
        if stream.read(4) != b"\x7fELF":
            raise RuntimeError(f"GNU {name} must resolve to an ELF shared object")
    return str(path)


def gnu_cpp_library():
    return gnu_runtime_library("libstdc++.so", "HYPERLANE_GNU_CXX_LIBRARY")

def gnu_unwind_library():
    return gnu_runtime_library("libgcc_s.so.1", "HYPERLANE_GNU_UNWIND_LIBRARY")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", default=os.environ.get("ZIG", "zig"))
    parser.add_argument("--sdk-root", default=os.environ.get("HYPERLANE_ZIG_SDKROOT"))
    parser.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    compiler = shutil.which(options.compiler)
    if compiler is None:
        parser.error("Zig 0.15.2 is required; set ZIG or --compiler to its path")
    version = subprocess.check_output([compiler, "version"], text=True).strip()
    if version != "0.15.2":
        parser.error(f"expected Zig 0.15.2, found {version}")
    args = options.args
    if args[:1] == ["--"]:
        args = args[1:]
    if not args:
        args = ["build", "--help"]
    if platform.system() == "Linux":
        if args[0] == "build" and any(value.startswith("-Dnative-db-libs=") for value in args):
            if not any(value.startswith("-Dnative-cxx-library=") for value in args):
                args = [*args, "-Dnative-cxx-library=" + gnu_cpp_library()]
            unwind = gnu_unwind_library()
            args = [value + "," + unwind if value.startswith("-Dnative-db-libs=") and unwind not in value.split("=", 1)[1].split(",") else value for value in args]
        elif args[0] in {"test", "build-exe", "build-lib"} and any(value in {"-lc++", "-lstdc++"} for value in args):
            args = [value for value in args if value not in {"-lc++", "-lstdc++"}]
            args.extend(value for value in [gnu_cpp_library(), gnu_unwind_library(), "-lpthread", "-ldl", "-lm"] if value not in args)
    env = os.environ.copy()
    with tempfile.TemporaryDirectory(prefix="hyperlane-zig-sdk-") as temporary:
        if options.sdk_root:
            if platform.system() != "Darwin":
                parser.error("--sdk-root is only supported on macOS")
            sdk = Path(options.sdk_root).resolve(strict=True)
            if not (sdk / "usr/lib/libSystem.tbd").is_file():
                parser.error("SDK must contain usr/lib/libSystem.tbd")
            shim = Path(temporary) / "xcrun"
            shim.write_text(
                '#!/bin/sh\n'
                'if [ "$#" = "3" ] && [ "$1" = "--sdk" ] && '
                '[ "$2" = "macosx" ] && [ "$3" = "--show-sdk-path" ]; then\n'
                '  printf "%s\\n" "$HYPERLANE_ZIG_SDKROOT"\n'
                'else\n  exec /usr/bin/xcrun "$@"\nfi\n'
            )
            shim.chmod(0o700)
            env["HYPERLANE_ZIG_SDKROOT"] = str(sdk)
            env["SDKROOT"] = str(sdk)
            env["PATH"] = temporary + os.pathsep + env.get("PATH", "")
        return subprocess.run([compiler, *args], cwd=Path(__file__).resolve().parents[1], env=env).returncode


if __name__ == "__main__":
    raise SystemExit(main())
