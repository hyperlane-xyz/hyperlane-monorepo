# @hyperlane-xyz/forking-sdk

## 8.1.3

### Patch Changes

- @hyperlane-xyz/utils@41.3.1
- @hyperlane-xyz/provider-sdk@8.1.2

## 8.1.2

### Patch Changes

- @hyperlane-xyz/utils@41.3.0
- @hyperlane-xyz/provider-sdk@8.1.1

## 8.1.1

### Patch Changes

- Updated dependencies [bd4e5f0]
  - @hyperlane-xyz/provider-sdk@8.1.0
  - @hyperlane-xyz/utils@41.2.0

## 8.1.0

### Minor Changes

- 0adcbb2: Added local mainnet forking support for Solana (Sealevel) warp routes and made the `warp fork` engine VM-agnostic.

  - Introduced `@hyperlane-xyz/forking-sdk`, a VM-agnostic forking abstraction: the `IForkManager<TConfig>` interface, a `ForkManagerRegistry` keyed by `ProtocolType`, a `buildForkedChainMetadata` orchestration routine, and readiness/port helpers. Depends only on `@hyperlane-xyz/provider-sdk` and `@hyperlane-xyz/utils`.
  - Added a node-only `@hyperlane-xyz/sealevel-sdk/fork` subpath (isolated from the main entry so browser/edge consumers are unaffected): a mode-typed `SurfpoolNode` controller (fork/network/offline) that runs a locally-installed `surfpool` binary, an `SvmForkManager` that forks a Solana RPC via surfpool and replays `PrintableSvmTransaction[]` governance txs under skip-signature-verification, and an `SvmRawForkConfigSchema` fork-config parser.
  - Reworked the CLI `warp fork` command to dispatch per protocol through `forking-sdk`: EVM chains fork with anvil (extracted into an `EvmForkManager`, behavior unchanged) and Sealevel chains fork with surfpool, with per-protocol fork-config parsing. A Sealevel warp route can now be forked and its governance transactions replayed and validated with `warp check` before being submitted on-chain or through a Squads multisig.
  - Hardened the `HttpServer.start()` used to serve the forked registry: it now awaits the `listening` event and rejects on a bind failure (instead of only logging), so a caller can observe the failure and tear down. The CLI `warp fork` command uses this to kill every fork node if the registry server cannot start, and redacts the upstream RPC URL (which may carry credentials) from any surfaced anvil error.
  - Note: `warp fork` on a Sealevel route requires a locally-installed `surfpool` binary (`>= 1.5.0`) on `PATH` — there is no Docker fallback in the CLI. Install a pinned, checksum-verified `surfpool` release (`>= 1.5.0`) from https://github.com/txtx/surfpool/releases (verify the archive's SHA-256) rather than piping the mutable installer to a shell. The `surfpool/surfpool:1.5.0` Docker image is used only by the SDK's own test suite.

### Patch Changes

- @hyperlane-xyz/utils@41.1.0
- @hyperlane-xyz/provider-sdk@8.0.4
