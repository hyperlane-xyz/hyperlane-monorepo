---
'@hyperlane-xyz/cli': minor
---

Added support for the `accessManager` submitter in submission strategies, including CLI-only submitters such as `file` as its `proposerSubmitter`, along with example strategies.
Added `--relay` support for interchain account submitters whose `internalSubmitter` is an `accessManager` with a `jsonRpc` proposer. Self-relay is skipped when the submitted receipt dispatches no message, as when the AccessManager schedules the call.
