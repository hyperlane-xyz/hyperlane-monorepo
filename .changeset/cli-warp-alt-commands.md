---
"@hyperlane-xyz/cli": minor
---

Three new CLI commands for managing SVM warp-route Address Lookup Tables were added: `hyperlane warp alt read` prints the on-chain contents of the ALTs registered for a warp route; `hyperlane warp alt check` diffs them against what the SDK would regenerate from on-chain state (non-zero exit on any diff); `hyperlane warp alt create` creates the frozen ALTs on chain and persists their addresses to the registry via `registry.addWarpRoute`. All three accept `--warp-route-id` and optionally `--chain` to scope to a single SVM chain. `warp alt create` also accepts `--force` / `-f` to regenerate only the warp-specific ALTs while reusing the registered core ALT, and `--full-force` / `-F` to regenerate everything; without either flag, chains that already have ALT entries in the registry are skipped (existing frozen ALTs cannot be reclaimed).
