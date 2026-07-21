---
"@hyperlane-xyz/sdk": patch
---

Updated the AltVM warp route check to treat a per-destination gas that reads back as 0 from the on-chain `destination_gas` entrypoint as equivalent to an omitted value in the deploy config, but ONLY for no-IGP origins (Starknet/paradex). Those synthetic routers were deployed without per-domain gas so they read 0 on-chain, while the expected side derives a non-zero EVM `gasOverhead` default for every remote, producing perpetual false-positive `destinationGas` violations in `check-warp-deploy` on chains that have no IGP to consume the value. IGP-capable altVM protocols (Sealevel, CosmosNative, ...) still diff destinationGas normally, so a zero-vs-nonzero drift there is preserved. A genuinely configured (non-zero) on-chain destinationGas always surfaces as a violation.
