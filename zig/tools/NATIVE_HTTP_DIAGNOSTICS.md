# Native HTTP metadata diagnostic

The native HTTP suite includes `native Pool yields eight stalled peers and verifies healthy EVM children three times`. Its test number changes as the suite grows. The fixture uses null ISMs, then performs real HTTP verification and gas-estimation calls; it does not exercise validator checkpoint signatures.

An intermittent failure can collapse child errors into `AggregationThresholdNotMet`. The existing diagnostic adds bounded observations to the pinned test source and restores the original file after the command. It records source custody, child verification/replay phases, Pool state and process cleanup.

On a push to `feat/zig-agent-rewrite`, these four commit-message markers select the ordered full-suite diagnostic with the ordinary wrapper's inherited environment policy:

```text
[zig-paired-linux] [zig-native-http-diagnostic-only] [zig-native-http-full-suite] [zig-native-http-ordinary-env]
```

Keep the paired workload selectors disabled. This route selects `native-http` and the inactive paired-input selector; it skips the SDK, SVM prerequisite, image and cold-build jobs. It does not rerun another workflow's attempt.

The inner command has a 1,200-second deadline and its outer owner has 1,240 seconds. The retained diagnostic log is bounded at 8 MiB. The original pinned source, compiled overlay and restored source are recorded separately. Check source restoration, actual waits and confirmed process absence alongside the command result.

A successful diagnostic is evidence about the instrumented suite. It does not establish the cause of an intermittent failure or replace an ordinary suite pass, native chain validation or a benchmark.

The [observed failure on producer M](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42688478305/job/129401592531) is retained separately from subsequent diagnostic runs.
