---
"@hyperlane-xyz/aleo-sdk": patch
"@hyperlane-xyz/ccip-server": patch
"@hyperlane-xyz/cli": patch
"@hyperlane-xyz/core": patch
"@hyperlane-xyz/cosmos-sdk": patch
"@hyperlane-xyz/cosmos-types": patch
"@hyperlane-xyz/deploy-sdk": patch
"@hyperlane-xyz/eslint-config": patch
"@hyperlane-xyz/github-proxy": patch
"@hyperlane-xyz/helloworld": patch
"@hyperlane-xyz/http-registry-server": patch
"@hyperlane-xyz/infra": patch
"@hyperlane-xyz/keyfunder": patch
"@hyperlane-xyz/metrics": patch
"@hyperlane-xyz/provider-sdk": patch
"@hyperlane-xyz/radix-sdk": patch
"@hyperlane-xyz/rebalancer": patch
"@hyperlane-xyz/rebalancer-sim": patch
"@hyperlane-xyz/relayer": patch
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/starknet-core": patch
"@hyperlane-xyz/tron-sdk": patch
"@hyperlane-xyz/tsconfig": patch
"@hyperlane-xyz/utils": patch
"@hyperlane-xyz/warp-monitor": patch
"@hyperlane-xyz/widgets": patch
---

The monorepo TypeScript toolchain was upgraded to 6.0.0-beta.

The beta release was adopted intentionally to unblock active development against TS6 behavior before stable 6.0.0 lands.

Shared TypeScript configs were updated to explicitly include required ambient types (notably `node` and `mocha`) for TS6 compatibility, and related package type wiring was aligned.

Compatibility fixes were applied to keep build/lint/test pipelines green under TS6, including lint flow hardening and test-import adjustments.

Rebalancer simulation startup reliability was hardened with robust local-Anvil fallback behavior when container runtimes are unavailable.

Container-runtime-unavailable detection was significantly expanded and hardened across Docker/Podman/Linux socket errors, Windows named-pipe signatures, nested wrapper error shapes, and hostile accessor scenarios.

Error-message extraction and formatting paths were hardened to avoid crashes and preserve useful diagnostics for hostile/non-standard payloads, including safer fallbacks through `String(error)`, inspect/JSON fallthroughs, and stable final placeholders.

`String(error)` and `Symbol.toPrimitive` placeholder handling was extensively normalized (including quoted, escaped, and case-variant placeholder forms) so non-informative outputs continue to structural fallbacks while informative outputs remain authoritative.

Regression guard tests were added to assert descriptor-matrix parity, exact descriptor-set cardinality, matcher/formatter base-set alignment, canonical descriptor baseline consistency, and explicit unescaped-alias baseline consistency across triple/json/double escaped `Symbol.toPrimitive` placeholder suites, preventing future drift in coverage.

TS6-beta compatibility was validated with:

- Workspace-level CI-equivalent checks: `pnpm build`, `pnpm lint`, `pnpm test:ci`.
- `typescript/ccip-server` compatibility checks: `pnpm -C typescript/ccip-server build`, `pnpm -C typescript/ccip-server lint`, `pnpm -C typescript/ccip-server test` (`ts-jest` path).
- Hardened `typescript/rebalancer-sim` targeted regression coverage (Anvil fallback/error-matrix/parity-guard suites).
- Additional package-smoke validation:
  - Unit/CI suites: `pnpm -C typescript/sdk test:unit`, `pnpm -C typescript/infra test:ci`, `pnpm -C typescript/cli test:ci`, `pnpm -C typescript/provider-sdk test:ci`, `pnpm -C typescript/deploy-sdk test`, `pnpm -C typescript/utils test`, `pnpm -C typescript/radix-sdk test:ci`, `pnpm -C typescript/rebalancer test`, `pnpm -C typescript/relayer test:ci`, `pnpm -C typescript/warp-monitor test:ci`, `pnpm -C typescript/keyfunder test:ci`, `pnpm -C typescript/http-registry-server test:ci`, `pnpm -C typescript/metrics test:ci`, `pnpm -C typescript/helloworld test:ci`, and `pnpm -C typescript/github-proxy exec vitest run`.
  - Build+lint sweeps: `typescript/provider-sdk`, `typescript/deploy-sdk`, `typescript/utils`, `typescript/cosmos-sdk`, `typescript/aleo-sdk`, `typescript/radix-sdk`, `typescript/tron-sdk`, `typescript/cosmos-types`, `typescript/widgets`, `typescript/rebalancer`, `typescript/relayer`, `typescript/warp-monitor`, `typescript/keyfunder`, `typescript/http-registry-server`, `typescript/metrics`, `typescript/helloworld`, `solidity` (`@hyperlane-xyz/core`), and `starknet` (`@hyperlane-xyz/starknet-core`) (`pnpm -C <pkg> build` + `pnpm -C <pkg> lint`).
  - Support package checks: `@hyperlane-xyz/eslint-config` importability and `@hyperlane-xyz/tsconfig` resolution via `pnpm exec tsc --showConfig -p typescript/sdk/tsconfig.json`.
  - Packages with intentionally empty CI test scripts were confirmed to report expected output (`aleo-sdk`, `tron-sdk`, `cosmos-types`, `cosmos-sdk`).
  - Existing non-blocking lint warnings remained in `typescript/widgets` (react-hooks dependency warnings), `typescript/keyfunder`/`typescript/warp-monitor`/`typescript/helloworld` (unused eslint-disable warnings in existing tests), `typescript/relayer` (pre-existing disabled-test warning), and `solidity` + `typescript/helloworld` Solhint warnings, consistent with workspace lint behavior.

Release graph hygiene was also checked with `pnpm changeset status`, confirming a coherent patch-only bump set for this rollout.

Known caveat: some ecosystem tooling advertised pre-TS6 peer ranges (for example, `@typescript-eslint` packages commonly declared `typescript >=4.8.4 <6.0.0`, some transitive utility variants declared `<5.9.0`, and `ts-jest@29.4.5` declared `typescript >=4.3 <6`). These warnings were treated as non-blocking for this rollout because repository lint/build/test paths remained green under TS6 beta.
