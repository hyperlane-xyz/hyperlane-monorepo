# Pinned RocksDB native bootstrap

The Zig agents use the same RocksDB10.4.2 storage engine and compression features
as production Rust `rocksdb0.24.0` / `librocksdb-sys0.17.3+10.4.2`. This directory
builds those native dependencies independently of the Rust agents. It is **not a
zero-native-dependency runtime**. No Rust agent logic or Rust rlib is linked.

## Build on a clean macOS/Linux host

Requirements: Python3.11+, Cargo/rustc1.98.0, native C/C++17 compiler, `ar`, `make`,
`pkg-config`, libclang and platform development headers/SDK. Linux examples use
`build-essential libclang-dev pkg-config python3`; macOS uses Command Line Tools.
Install the pinned Rust toolchain with rustup if necessary. `LIBCLANG_PATH` can
explicitly select its installed shared library. The helper supports native
x86_64/aarch64 hosts; it does not silently cross-compile another architecture.

```
python3 zig/tools/native_deps.py --format json > native-deps.json
LIBS="$(python3 zig/tools/native_deps.py --format libs)"
python3 zig/tools/zig.py build native-db-test "-Dnative-db-libs=$LIBS"
```

For the known Zig0.15.2/macOS linker SDK issue, pass the same explicit SDK to both
steps. SDK selection is task-local; no SDK symlinks/system files are changed.
Native compilation defaults to macOS11.0 deployment, independent of host OS.

```
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
LIBS="$(python3 zig/tools/native_deps.py --sdk-root "$SDK" --format libs)"
python3 zig/tools/zig.py --compiler /path/to/zig-0.15.2 --sdk-root "$SDK" \
  build native-db-test "-Dnative-db-libs=$LIBS"
```

Outputs default to ignored `zig/native/rocks/out/`; isolated Cargo artifacts stay
under ignored `target/`. `--target-dir` / `--output` select clean CI directories.
`--offline` forbids Cargo fetching. `--jobs` defaults to at most4; cancellation
and `--build-timeout` terminate the whole task-owned Cargo/compiler process group.
`--restore-only` recreates the ignored Cargo.lock from reviewed checksum chunks.

Source/feature inputs are pinned, including **all46 registry build packages**.
The empty local Cargo root makes47 lock entries. `lock.json` restores Cargo.lock;
every registry version/source/checksum must also exist in production Cargo.lock.
Actual extracted compiler inputs are rechecked against checksum-pinned `.crate`
archives. The compiler cannot silently substitute system RocksDB/compression
libraries via environment overrides. Native source builds set SOURCE_DATE_EPOCH0
and ZERO_AR_DATE1. Compiler/platform/SDK differences still produce different
binaries; this bootstrap does not promise cross-platform byte-identical archives.
The manifest records the actual compiler, input hashes and archive hashes.

Exact sys features omit `default`: rocksdb0.24 disables librocksdb-sys defaults,
explicitly requests `static`, then enables Snappy/LZ4/Zstd/zlib/bzip2 and runtime
bindgen through its wrapper defaults. A cached build using a different feature
set is rejected by explicit import rather than silently accepted.

## Existing Rust target reuse

```
python3 zig/tools/native_deps.py --from-rust-target rust/main/target \
  --sdk-root "$SDK" --output zig/native/rocks/out-imported --format json
```

This mode is read-only with respect to the supplied Rust target. It correlates
the RocksDB native output to an exact-version Cargo depfile and exact-feature
fingerprint, verifies compression source versions, then runs the same linked
runtime/codec probe. It never builds full agents. Existing objects retain their
original compiler/deployment flags; importing cannot lower their minimum OS.
The import manifest explicitly marks original compiler flags as unreproduced.
Use the clean source build for portable CI artifacts. Registry source paths in
an imported depfile must still match the current checksum-verified Cargo cache.

## Runtime ABI and dependency boundary

The bundle contains7 archives: the version-only C++ shim, RocksDB, Snappy, LZ4,
Zstd, zlib and bzip2. Link the emitted list via `-Dnative-db-libs`. The native
compression versions differ from their Rust wrapper versions:

| Component                | Crate                       | Actual native version                 |
| ------------------------ | --------------------------- | ------------------------------------- |
| RocksDB + bundled Snappy | librocksdb-sys0.17.3+10.4.2 | RocksDB10.4.2 / bundled pinned Snappy |
| LZ4                      | lz4-sys1.10.0               | LZ41.9.4                              |
| Zstd                     | zstd-sys2.0.13+zstd.1.5.6   | Zstd1.5.6                             |
| zlib                     | libz-sys1.1.16              | zlib1.3.1                             |
| bzip2                    | bzip2-sys0.1.11+1.0.8       | bzip21.0.8                            |

C/C++ runtimes are additional system dependencies. Darwin uses libc++; Linux
uses production libstdc++ plus pthread/dl/m. `system_link_args` in manifest.json
records this distinction; do not force a second incompatible C++ runtime.
Bindgen/libclang and46 Rust crates are build dependencies, not runtime libraries.
No generated Rust bindings/rlibs or Rust agent crates enter the link list.

RocksDB's official C API has no runtime-version getter. `abi.cc` provides only:

- `ziggy_rocksdb_abi_version() == 1`
- `ziggy_rocksdb_header_version() == 0x0a0402`
- `ziggy_rocksdb_runtime_version() == "10.4.2"` from the actual linked engine

`abi.zig.verify()` checks these before opening an agent DB. Build integration must
provide this module or equivalent declarations; importing the file outside a
Zig source-module root requires an explicit named module. The standalone probe
checks runtime versions and writes, flushes, closes and reopens actual SST data
using no compression, Snappy, zlib, bzip2, LZ4, LZ4HC and Zstd. Unsupported codecs
or a wrong engine fail the helper. Agents retain their existing fatal bzip2
invariant callback; the standalone probe supplies its own callback only.

`licenses/` preserves all111 discovered license/notice/author files from the
locked source packages, including vendored C/C++ components. Manifest entries
record copied license hashes and original package license metadata. Archive and
compiler logs contain public build paths; no configured agent DB is opened.

## Verification

```
python3 -m unittest discover -s zig/native/rocks -p 'test_*.py' -v
python3 zig/tools/native_deps.py --offline --sdk-root "$SDK" \
  --target-dir zig/native/rocks/target-clean --output zig/native/rocks/out-clean
```

Evidence obtained locally on native macOS arm64: clean standalone source build,
all7 codec reopen probes, explicit production-Rust-target import, and actual Zig
native batch/fsync/reopen/iterator-ownership test against the standalone archives.
Linux runtime flags are unit tested; a Linux native compile/run remains a CI gate.
