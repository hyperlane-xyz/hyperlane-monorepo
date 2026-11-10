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

The diagnostic step uses `continue-on-error`. A green job does not establish a passing test command. Read the published `summary.json` command exit code, named test record, original/compiled/restored source inventories and both owner cleanup results before reporting a pass.

The controlled four-slot test uses four ISM children with threshold two and sixteen RPC endpoints, eight of which stall. Four held verification sessions fill the real Pool. Releasing two children allows their gas-estimation sessions to fill the two remaining slots; the test checks actual external admission refusals at both barriers, preserved cached reads and full cancellation drain. The legacy sixteen-child fixture remains separate. This focused test does not reproduce the intermittent sixteen-child failure or prove that a selected child's gas admission was refused.

Failure rows distinguish cumulative successful fixture writes, upstream completion masks for actual session IDs, terminal events, and finished/consumed flags. These are separate observations: a fixture write does not prove client receipt or a matching vote, and a terminal event can precede the finished flag's publication.

The [latest ordinary-suite failure](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42819913292/job/129842497201) ended the first metadata build after 120.047 seconds with eight verification failures and unretained child error classes. All sixteen fixture paths recorded thirty requests each. Those hits precede response writes, and the failure counters exclude some cancelled deadline events, so neither observation identifies the cause. The [preceding ordinary suite](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42816003885/job/129829150144) passed with the same inspected Zig execution sources; native-library equivalence between the runners has not been established.

The next diagnostic uses the existing ordered full-suite, inherited-environment route to collect actual runtime context and failure observations. The scraper compatibility fix and smaller typed-error diagnostic remain separate, unapplied proposals. This diagnostic changes no production implementation, deadline, quorum or acceptance condition; a passing instrumented run still leaves the intermittent cause unresolved.
