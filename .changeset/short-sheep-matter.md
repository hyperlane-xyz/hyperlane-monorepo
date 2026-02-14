---
'@hyperlane-xyz/cli': patch
---

Submitter selection in CLI commands was inferred automatically per transaction for `warp apply`, `submit`, and `core apply`, allowing mixed submitter routing on the same chain while preserving explicit strategy overrides and falling back to JSON-RPC when inference is not possible. Chain strategies now also support optional per-target overrides through `submitterOverrides`.
