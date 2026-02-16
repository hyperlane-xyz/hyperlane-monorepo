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

TS6-beta compatibility was validated across `pnpm build`, `pnpm lint`, `pnpm test:ci`, package-level `pnpm -C typescript/ccip-server test` (`ts-jest` path), and targeted `typescript/rebalancer-sim` regression coverage.

Known caveat: some ecosystem tooling still advertises pre-TS6 peer ranges (for example, `@typescript-eslint` packages commonly declare `typescript >=4.8.4 <6.0.0`, some transitive utility variants declare `<5.9.0`, and `ts-jest@29.4.5` declares `typescript >=4.3 <6`). These warnings were treated as non-blocking for this rollout because repository lint/build/test paths remained green under TS6 beta.
