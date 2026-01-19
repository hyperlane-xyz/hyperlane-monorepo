---
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/infra': patch
'@hyperlane-xyz/rebalancer': patch
---

Added `mapAllSettled` helper to @hyperlane-xyz/utils for typed parallel operations with key-based error tracking. Migrated Promise.allSettled patterns across sdk, cli, infra, and rebalancer packages to use the new helper.
