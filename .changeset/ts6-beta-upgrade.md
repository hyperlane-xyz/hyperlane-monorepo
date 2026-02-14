---
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/cli": patch
"@hyperlane-xyz/utils": patch
"@hyperlane-xyz/cosmos-sdk": patch
"@hyperlane-xyz/aleo-sdk": patch
"@hyperlane-xyz/radix-sdk": patch
"@hyperlane-xyz/widgets": patch
"@hyperlane-xyz/deploy-sdk": patch
"@hyperlane-xyz/core": patch
"@hyperlane-xyz/starknet-core": patch
"@hyperlane-xyz/rebalancer": patch
"@hyperlane-xyz/tron-sdk": patch
"@hyperlane-xyz/cosmos-types": patch
---

The monorepo TypeScript toolchain was upgraded to 6.0.0-beta.

Shared TypeScript configs were updated to explicitly include `node` and `mocha` ambient types for TS6 compatibility, and package type dependencies were aligned accordingly.

TS6 compatibility fixes were applied in lint configuration and tron-sdk test imports to keep build and lint pipelines green.

Test execution ergonomics were also improved by adding a local-Anvil fallback for rebalancer simulation tests (when Docker is unavailable), and by making infra registry resolution fallback to the packaged registry data when no local registry clone is present.

The root lint command was also hardened to retry turbo lint serially only on OOM (exit code 137), while preserving normal failure behavior for real lint errors.
