---
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/utils": minor
"@hyperlane-xyz/cosmos-sdk": minor
"@hyperlane-xyz/aleo-sdk": minor
"@hyperlane-xyz/radix-sdk": minor
"@hyperlane-xyz/widgets": minor
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/core": patch
"@hyperlane-xyz/starknet-core": patch
---

Upgrade TypeScript from 5.3.3 to 5.8.3 and compilation target to ES2023

- Upgraded TypeScript from 5.3.3 to 5.8.3 across all packages
- Updated compilation target from ES2022 to ES2023 (Node 16+ fully supported)
- Converted internal const enums to 'as const' pattern for better compatibility
- Updated @types/node from ^18.14.5 to ^20.17.0 for TypeScript 5.7+ compatibility
- Fixed JSON imports to use required 'with { type: "json" }' attribute (TS 5.7+ requirement)
- No breaking changes to public API - all changes are internal or non-breaking
