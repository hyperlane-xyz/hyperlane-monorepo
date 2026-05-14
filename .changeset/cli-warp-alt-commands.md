---
"@hyperlane-xyz/cli": minor
---

Three new CLI commands for managing SVM warp-route Address Lookup Tables were added: `hyperlane warp alt read` prints the on-chain contents of the ALTs registered for a warp route; `hyperlane warp alt check` diffs them against what the SDK would regenerate from on-chain state (non-zero exit on any diff); `hyperlane warp alt create` creates both ALTs frozen on chain and persists their addresses to the registry via `registry.addWarpRoute`. All three accept `--warp-route-id` and optionally `--chain` to scope to a single SVM chain.
