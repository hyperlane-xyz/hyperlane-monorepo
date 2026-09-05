# CCIP startup benchmark

Build parent and head in separate checkouts with identical Node/dependency versions:

```sh
pnpm --filter @hyperlane-xyz/ccip-server build
pnpm --filter @hyperlane-xyz/ccip-server bundle
```

Then compare the complete local bundle directories (not just copied index files):

```sh
python3 typescript/ccip-server/benchmarks/startup.py \
  /path/to/parent/typescript/ccip-server/bundle/index.js \
  /path/to/head/typescript/ccip-server/bundle/index.js \
  --node /absolute/path/to/node --rounds 5
```

Requires Python 3, Node and POSIX signals. It alternates fresh processes with `cctp,callCommitments` enabled, creates a synthetic filesystem registry, disables outbound Node socket/fetch calls, and polls only loopback health/metrics endpoints. Each process uses temporary ports and is stopped after measurement. No database or remote chain service is queried. Port selection has the usual local bind/release race; rerun if another local process claims a selected port.

Output includes all samples, median readiness (both health and metrics responding), heap/RSS after explicit GC, and complete bundle bytes/file counts. Readiness includes process spawning and 10ms HTTP polling granularity. Bundle builds, dependency installation and filesystem cache effects are outside the timed interval. These are local startup measurements, not production request latency, image-size savings, or transaction validation. Do not use production registry data or credentials for this benchmark.
