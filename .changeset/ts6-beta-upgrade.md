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

The local-Anvil fallback reliability was further improved by handling additional docker socket connection error patterns and hardening local process shutdown edge cases.

Fallback diagnostics were also hardened to handle nested and wrapped runtime errors (including cross-platform Docker daemon failure formats) and to produce clearer messages for non-standard error payloads.

Runtime-unavailable detection coverage was further expanded to include Podman socket failure signatures and iterable/map/object nested error collection formats emitted by container tooling wrappers.

Socket-runtime detection coverage was also expanded for missing-socket daemon errors (`ENOENT` and `no such file or directory` formats) across both Docker and Podman paths.

Windows named-pipe runtime-unavailable detection was further expanded to include Docker Desktop `dockerDesktopLinuxEngine` pipe failure signatures.

Windows matcher coverage was additionally expanded for URL-encoded named-pipe path signatures emitted by Docker daemon connection errors.

Windows named-pipe detection was further broadened to include `dockerDesktopEngine` signatures across npipe, slash/backslash path, and URL-encoded forms.
