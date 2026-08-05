---
'@hyperlane-xyz/forking-sdk': minor
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/cli': minor
---

Added local mainnet forking support for Solana (Sealevel) warp routes and made the `warp fork` engine VM-agnostic.

- Introduced `@hyperlane-xyz/forking-sdk`, a VM-agnostic forking abstraction: the `IForkManager<TConfig>` interface, a `ForkManagerRegistry` keyed by `ProtocolType`, a `buildForkedChainMetadata` orchestration routine, and readiness/port helpers. Depends only on `@hyperlane-xyz/provider-sdk` and `@hyperlane-xyz/utils`.
- Added a node-only `@hyperlane-xyz/sealevel-sdk/fork` subpath (isolated from the main entry so browser/edge consumers are unaffected): a mode-typed `SurfpoolNode` controller (fork/network/offline) that runs a locally-installed `surfpool` binary, an `SvmForkManager` that forks a Solana RPC via surfpool and replays `PrintableSvmTransaction[]` governance txs under skip-signature-verification, and an `SvmRawForkConfigSchema` fork-config parser.
- Reworked the CLI `warp fork` command to dispatch per protocol through `forking-sdk`: EVM chains fork with anvil (extracted into an `EvmForkManager`, behavior unchanged) and Sealevel chains fork with surfpool, with per-protocol fork-config parsing. A Sealevel warp route can now be forked and its governance transactions replayed and validated with `warp check` before being submitted on-chain or through a Squads multisig.
- Note: `warp fork` on a Sealevel route requires a locally-installed `surfpool` binary (`>= 1.5.0`) on `PATH` — there is no Docker fallback in the CLI (install with `curl -sSfL https://run.surfpool.run/ | bash`). The `surfpool/surfpool:1.5.0` Docker image is used only by the SDK's own test suite.
