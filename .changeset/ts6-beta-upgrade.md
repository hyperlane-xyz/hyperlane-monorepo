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
  - Unit/CI suites: `pnpm -C typescript/sdk test:unit`, `pnpm -C typescript/infra test:ci`, `pnpm -C typescript/cli test:ci`, `pnpm -C typescript/provider-sdk test:ci`, `pnpm -C typescript/deploy-sdk test`, `pnpm -C typescript/utils test`, `pnpm -C typescript/radix-sdk test:ci`.
  - Build+lint sweeps: `typescript/provider-sdk`, `typescript/deploy-sdk`, `typescript/utils`, `typescript/cosmos-sdk`, `typescript/aleo-sdk`, `typescript/radix-sdk`, `typescript/tron-sdk`, `typescript/cosmos-types` (`pnpm -C <pkg> build` + `pnpm -C <pkg> lint`).
  - Packages with intentionally empty CI test scripts were confirmed to report expected output (`aleo-sdk`, `tron-sdk`, `cosmos-types`).

Release graph hygiene was also checked with `pnpm changeset status`, confirming a coherent patch-only bump set for this rollout.

Known caveat: some ecosystem tooling advertised pre-TS6 peer ranges (for example, `@typescript-eslint` packages commonly declared `typescript >=4.8.4 <6.0.0`, some transitive utility variants declared `<5.9.0`, and `ts-jest@29.4.5` declared `typescript >=4.3 <6`). These warnings were treated as non-blocking for this rollout because repository lint/build/test paths remained green under TS6 beta.
