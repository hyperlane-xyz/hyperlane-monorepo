# Zig agent container (alpha draft)

This package builds the actual Zig `relayer`, `validator`, and `scraper` service
entry points. It does not build or include the Rust agents, production chain
configuration, credentials, signing keys, or a deployment manifest. It is not a
production rollout or a completed all-VM parity claim.

## Image targets

Build from the repository root. `zig/Dockerfile.dockerignore` includes Zig and
the Rust workspace sources/configuration needed by the separate migration image
and public test fixtures. Generated targets, caches, and secret-file patterns are
excluded. The lock and native helper verify the production RocksDB baseline;
Rust source is a build input and is absent from the agent runtime image. The
final stage aliases `runtime-core`, so omitting `--target`
also produces the minimal image rather than pulling optional SDKs.

```sh
docker build --target runtime-core --tag hyperlane-zig-agents:alpha-core -f zig/Dockerfile .
docker build --target runtime-starknet --tag hyperlane-zig-agents:alpha-starknet -f zig/Dockerfile .
docker build --target runtime-aleo --tag hyperlane-zig-agents:alpha-aleo -f zig/Dockerfile .
docker build --target runtime-full-sdk --tag hyperlane-zig-agents:alpha-full-sdk -f zig/Dockerfile .
```

| Target             | Included native SDK surface                           | Qualification                                                |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| `runtime-core`     | Three agents, RocksDB bundle, libcurl, OpenSSL, libpq | Default; no Starknet/Aleo crypto claimed                     |
| `runtime-starknet` | Core plus pinned `starknet-crypto` bridge             | Adds the separate Rust crypto dependency                     |
| `runtime-aleo`     | Core plus Aleo crypto/VM bridges and isolated worker  | Proving still requires an explicit external parameter bundle |
| `runtime-full-sdk` | Both preceding SDK variants                           | Not a claim that every VM service factory is complete        |

All targets use nonroot UID/GID `10001`, default to `relayer`, and accept only
`relayer`, `validator`, or `scraper` as the role. Arguments are passed directly
with `exec ... "$@"`; there is no `eval` or curl shell wrapper.

```sh
docker run --rm hyperlane-zig-agents:alpha-core --help
docker run --rm hyperlane-zig-agents:alpha-core validator --help
docker run --rm hyperlane-zig-agents:alpha-core scraper --help

docker run --rm \
  --mount type=bind,src="$PWD/config",dst=/etc/hyperlane,readonly \
  --mount type=bind,src="$PWD/database",dst=/var/lib/hyperlane \
  hyperlane-zig-agents:alpha-core relayer
```

`HYPERLANE_ZIG_DEFAULTS` defaults to `/etc/hyperlane`. Native defaults are
`libcurl.so.4` and `libcrypto.so.3`; override them only with vetted SONAMEs or
paths. Mount configuration separately from writable database state. Do not put
credentials in an image build argument or layer.

## Cold native dependencies versus agent compilation

The Dockerfile performs a clean native build with at most four Cargo jobs. The
two operations can also be run independently on Linux:

```sh
export ZIG="$(python3 zig/tools/bootstrap.py)"
python3 zig/tools/native_deps.py --jobs 4 \
  --target-dir "$PWD/zig/native/rocks/target-container" \
  --output "$PWD/zig/native/rocks/out-container" --format json
LIBS="$(python3 -c 'import json; print(json.load(open("zig/native/rocks/out-container/manifest.json"))["native_db_libs"])')"
LIBPQ="$(readlink -f "$(pkg-config --variable=libdir libpq)/libpq.so.5")"
GNU_UNWIND="$(readlink -f "$(c++ -print-file-name=libgcc_s.so.1)")"
python3 zig/tools/native_http_tests.py --timeout-seconds 3600 -- \
  python3 zig/tools/zig.py build native-db-test relayer validator \
  -Doptimize=ReleaseSafe "-Dnative-db-libs=$LIBS,$GNU_UNWIND"
python3 zig/tools/zig.py build scraper -Doptimize=ReleaseSafe "-Dlibpq-library=$LIBPQ"
```

Zig 0.15.2 is downloaded only through `bootstrap.py`, which checks the official
versioned archive size and SHA-256. Rust 1.98.0, Debian, and the Python 3.12
build image are pinned by registry manifest-list digest. Each digest is split
into 32+32-character arguments and composed at `FROM`/workflow use, preserving
the immutable reference without a long public-hex hook false positive. Python
3.12 supplies the helper's safe tar extraction filter while the Rust builder
remains Bookworm. Linux compilation is native, not a macOS SDK workaround. CI
compiles/tests amd64 separately from any local arm64 image evidence.

The builder also installs Node for the existing `native_http_tests.py` fixture
helper. Native DB tests now reach substantive RS256/ADC tests, so Docker and
native CI provision a fresh temporary RSA fixture and HTTP/2 server for each test
binary. Node and fixture keys stay out of runtime images. A filtered import-root
run does not establish that an unfiltered native suite cannot reach these tests.

### Dependency boundary and limits

- Seven static archives enter relayer/validator: the version-only C++ ABI shim,
  RocksDB 10.4.2, Snappy, LZ4, Zstd, zlib, and bzip2. The helper verifies all
  seven codec reopen modes and the actual 10.4.2 ABI before linking.
- The RocksDB closure has 46 registry build packages. C/C++17, clang/libclang,
  CMake/make, Cargo, and Rust are build requirements only. No Rust agent logic,
  Rust rlib, or Rust runtime is linked into the agents. The link also includes
  the compiler-matched GNU `libgcc_s.so.1` unwind object; it is a system runtime
  dependency, not an eighth bundled archive.
- Runtime Debian packages are CA certificates, libcurl4, OpenSSL 3, libpq, and
  GNU C++ runtime dependencies. Compression engines remain static. The runtime
  probe requires libcurl HTTP/2 and async DNS; redirects stay disabled. The curl
  command-line binary is intentionally absent.
- Builder and runtime select only `libcurl4`/development package version
  `8.14.1-2+deb13u2~bpo13+1` from the signed `bookworm-backports` suite. The unusual
  package suffix is the actual repository version; libc 2.36, OpenSSL 3.0 and
  GNU C++ runtime stay on Bookworm. No global backports distribution upgrade is
  used. The runtime probe records the actual loaded curl version as well as
  HTTP/2 and async DNS capabilities.
- HTTP/2 capability alone is insufficient: Bookworm's libcurl 7.88.1 failed the
  second prior-knowledge stream on a reused connection, including with the stock
  curl CLI and both Node 18 and Node 26 fixtures. The pinned 8.14.1 package passes
  those same requests. This matches the upstream
  [HTTP/2 connection-reuse fix](https://github.com/curl/curl/pull/10643).
  Bare Linux deployments need a vetted library with that fix; these results do
  not claim every library advertising HTTP/2 is compatible. TLS and connection
  reuse policy are unchanged.
- `HYPERLANE_REGEX_LIBRARY` loads the locked Rust regex 1.10.6 bridge
  (`regex-automata` 0.4.7 / `regex-syntax` 0.8.4). This separate third-party
  regex dependency preserves body-match semantics instead of disabling them.
  Native CI runs `ops_tests.zig` against the actual Linux library.
- Starknet adds its separately counted pinned native-crypto lock (94 packages in
  the adapter documentation). Aleo separately counts native-crypto (229) and
  native-VM (398) lock entries. These third-party protocol crypto/decode/proving
  dependencies are not rewritten Hyperlane agent logic.
- Native dependency build parallelism defaults to four and its helper deadline
  is 3600 seconds. CI allows 120 minutes for native/core jobs and 180 minutes for
  VM SDK image jobs. These are deadlines, not throughput measurements.
- The image does not impose container CPU, memory, PID, or disk quotas. Set those
  at the orchestrator after measuring the selected VM/configuration. Image size,
  ELF dependencies, architecture, and native package counts are recorded by
  `container_check.py`; no uniform memory or disk claim is made for all roles.
- Existing agent bounds still apply, including relayer 4096 active operations,
  64 MiB active retained bytes plus 256 MiB retained cache, and scraper 4096
  lanes. Aleo proving is one session/process/job with an absolute deadline and
  Linux address-space limits, not an unbounded in-process proving pool.

## Aleo parameters and offline execution

The Aleo images deliberately do **not** contain parameter files or set
`HYPERLANE_ALEO_PARAMETER_HOME`. Provision public parameters before an offline
run using the existing pinned helper, which verifies each official size/hash:

```sh
python3 zig/src/aleo/testing/locked.py --toolchain 1.98.0
python3 zig/src/aleo/testing/parameters.py \
  --home "$PWD/aleo-parameters" --network mainnet --max-degree 18 --fetch

docker run --rm \
  -e HYPERLANE_ALEO_PARAMETER_HOME=/opt/hyperlane/aleo-parameters \
  --mount type=bind,src="$PWD/aleo-parameters",dst=/opt/hyperlane/aleo-parameters,readonly \
  --mount type=bind,src="$PWD/config",dst=/etc/hyperlane,readonly \
  --mount type=bind,src="$PWD/database",dst=/var/lib/hyperlane \
  hyperlane-zig-agents:alpha-aleo relayer
```

The degree-18 local proof fixture needs nine unique files and 79,506,114 bytes;
larger programs can require more standard parameters. Missing files fail rather
than triggering a runtime download. The worker has no network or child-exec
capability. No fake parameters or private keys are bundled.

## Verification and evidence

```sh
chmod +x zig/entrypoint.sh
python3 zig/tools/container_check.py static --output zig/bench/results/container-static.json
python3 zig/tools/container_check.py runtime \
  --image hyperlane-zig-agents:alpha-core \
  --output zig/bench/results/container-runtime.json
```

The runtime check executes all three `--help` paths, checks nonroot metadata,
RocksDB manifest/version, seven archives, native HTTP/crypto/PQ features, and
`ldd` resolution. It rejects a curl CLI, unresolved libraries, wrong default
role, and baked Aleo parameter-home claims.

The full local-only smoke additionally starts pinned PostgreSQL 16.15, applies
all 21 production migrations, starts each agent with generated public fixture
configuration, sends SIGTERM, checks clean drain, and repeats with the same
DB/PG state. The RPC server is loopback-only and returns safe errors. Logs are
stored only after URL/key scans.

```sh
docker build --target migration-image \
  --tag hyperlane-zig-agents:alpha-migration -f zig/Dockerfile .
python3 zig/tools/container_check.py runtime \
  --image hyperlane-zig-agents:alpha-core --smoke \
  --migration-image hyperlane-zig-agents:alpha-migration \
  --output zig/bench/results/container-smoke.json
```

The migration image is fixture-only and executes Linux `init-db` through Docker;
it is separate from `runtime-core` and also works from a macOS host. To validate
only PostgreSQL and the migrations without starting the agents, run:

```sh
python3 zig/tools/container_check.py migrations \
  --migration-image hyperlane-zig-agents:alpha-migration \
  --output zig/bench/results/container-migrations.json
```

CI separately runs the existing RocksDB native tests and PostgreSQL integration
against PostgreSQL 16.15, including rollback/reorg behavior and the scraper
process. Test evidence is uploaded on success and failure. There are no jobs
that silently pass by omitting native library configuration.

For a rollback dry run, stop agents before cloning RocksDB state; do not copy a
live database directory. Record the native manifest and source/image digests
with the clone, reopen it with the same pinned 10.4.2 bundle, and run the native
DB tests before considering restoration. PostgreSQL migrations are forward-only
in this package; no down-migration or production rollback claim is made.

## CI shape

- Existing unit, repository EVM, and native HTTP fixtures remain separate jobs.
- `native-linux` builds the seven archives, runs native DB, durable-directory,
  exact-regex, and native WS/WSS tests, builds all three CLIs, compiles the
  Bridge Solidity fixture, executes the Bridge binary from the repository root,
  runs the PG16.15/21-migration integration, and uploads evidence.
- `container` builds the core and fixture-only Linux migration images, then runs
  the full smoke.
- `vm-images` is a qualified `starknet`/`aleo` matrix. The Starknet build stage
  runs the batch/nonce proof root and native DB tests after building and selecting
  its actual crypto library, so SDK-dependent group recovery tests execute there.
  Both variants check SDK linkage and role help without downloading parameters
  or claiming all-VM production proof. Local final-image acceptance is recorded
  below; remote amd64 CI execution is a separate result.

Draft PR/parent integration only. No image is deployed by this workflow.

## Local Linux acceptance — 2026-11-06

| Image    | Local image ID | Uncompressed bytes | Result |
| -------- | -------------- | -----------------: | ------ |
| Core     | `2e76904a1a51` |        284,657,476 | Passed |
| Full SDK | `c706d5317f77` |        359,489,415 | Passed |

Both images run as UID/GID 10001 on Linux/arm64. All three role help paths,
native linkage, HTTP/2, asynchronous DNS, OpenSSL 3, and libpq checks pass. Each
role starts twice against the same database and exits zero after SIGTERM.
Disposable PostgreSQL 16.15 applies all 21 production migrations through the
previously verified, separate Linux migration image.

The Docker native gate passes 970 of 1,028 tests with 58 optional SDK skips.
After loading Starknet crypto it passes 1,007 with 21 optional skips, and the
focused Starknet gate passes all 44 tests. The final full image additionally
passes 75 selected Aleo tests (34 named cases), 44 Starknet tests (31 named),
nine matching/regex tests (seven named), and both actual HTTP/2 cases. The latter
root reports 43 passes including 41 import roots. These runtime selections have
zero skips and use the image's actual libraries and baked worker as UID 10001.
Python/Node are installed only in a discarded fixture layer; proving parameters
are an external, verified, read-only public bundle.

The core build/runtime source snapshot is unchanged across acceptance. Full SDK
COPY predates only a test-only macOS fixture guard: an owned, unlistened TCP port
returns immediate refusal on Linux but queues SYNs on Darwin. Production worker
statements are identical, and the final runtime tests execute the current guarded
fixture. macOS Safe/Fast and Linux Safe focused controls pass. Earlier failures,
their corrections, exact commands, image identities, and package closure are
retained in the [lossless acceptance archive](../../zig/bench/results/container-acceptance/manifest.json.gz).
These are functional checks, not final benchmark timings or a remote amd64 CI run.
