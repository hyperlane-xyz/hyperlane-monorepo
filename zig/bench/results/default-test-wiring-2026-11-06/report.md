# Dependency-light default test wiring

The default test root and full native RocksDB aggregate both compile and link after the wiring fix. No native library was added to the default or native-db build. Test wiring is released; the separate malformed-HTTP503 validator regression remains assigned to protocol_recovery before the parent's next global run.

## Exact dependency reaches

- `agents/validator/generic.zig` embedded two real RocksDB regressions, and `agents/validator/evm.zig` embedded a third. Default root exports both implementation modules, so their test declarations linked native RocksDB/ABI calls through fetch_backoff_test.Database.open. Those three test declarations now live in NEW `agents/validator/fetch_backoff_native_test.zig`, imported explicitly by db_tests.zig. Test-only NativeTests namespaces retain same-file access to private Role methods and call the identical original helper/arguments. Production builds receive empty namespaces. Every original assertion, test name, actual native store/HTTP path and failure scenario is preserved.
- `critical_metrics_tests.zig` imported concrete `agents/scraper/task.zig` alongside the pure Tracker. That concrete owner instantiates PostgreSQL pool teardown and caused missing PQfinish. Its import now belongs to pg_tests.zig. All four scraper cadence/lifecycle/control regressions remain unchanged and pass in the proper libpq aggregate. The pure Tracker remains in default/native-db/PostgreSQL roots.
- The health suite was suspected by the initial link report, but isolation proved health_metrics_tests.zig links with libc alone. Its common/provider/native-wallet/role tests remain in default; no coverage was removed unnecessarily.

build.zig and root.zig were unchanged. There are no runtime skips, removed assertions, new production behavior, or added default link dependencies.

## Validation

| Check | Result | Evidence |
| --- | --- | --- |
| Full default root, libc only, --test-no-exec | linked, exit0 | default-link-command.json / default-link.log |
| Full db_tests root, seven Rocks/compression archives + existing C++ ABI, no libpq, --test-no-exec | linked, exit0 | native-link-command.json / native-link.log |
| Relocated concrete scraper regressions in pg_tests with libpq | 10/10 passed, zero skips (4 substantive cases) | scraper-pg-critical.log |
| Health root isolated with libc only | linked, exit0 | isolated-health-link.log |
| Original concrete scraper import isolated with libc only | expected PQfinish link failure; diagnosed reach | isolated-critical-link.log |
| Relocated validator native regressions | generic backoff and generic initialization passed; EVM case exposed SyntaxError (25pass/1fail, no skips) | validator-native.log |
| zig fmt --check on six edited/new files | passed | manifest.json |

The preserved EVM fixture intentionally returns HTTP503 with a plain-text body for eth_getLogs and tip failures. The recent Ethereum all-status JSON codec now emits SyntaxError for that body, while runtime/indexing_observer.retryable excludes it. The actual validator stops before healthy fallback/backoff. Parent assigned that independent production correction to protocol_recovery; the fixture and assertions were not changed to hide it. Exact command/root/filter/environment were handed directly to that owner. This known failure is not a remaining linker problem and not acceptance of the full suite.

Compile-only logs are empty on successful direct Zig invocation; structured exit outcomes are recorded in manifest.json. All commands run from repository root. Native tests use HYPERLANE_CURL_LIBRARY=/usr/lib/libcurl.4.dylib. No PostgreSQL connection is needed for the four relocated pure lifecycle assertions, though their concrete owner requires libpq linkage. Parent still owns full default/native/PG execution on a fresh global attempt, final Source freeze and any binary/benchmark pins. No benchmark, container, production credential, commit or push occurred in this slice.
