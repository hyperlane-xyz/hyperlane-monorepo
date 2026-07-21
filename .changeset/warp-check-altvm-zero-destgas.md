---
"@hyperlane-xyz/sdk": patch
---

Updated the AltVM warp route check to treat a per-destination gas that reads back as 0 from the on-chain `destination_gas` entrypoint as equivalent to an omitted value in the deploy config. Starknet/paradex synthetic routers deployed without per-domain gas read 0 on-chain, while the expected side derives a non-zero EVM `gasOverhead` default for every remote, producing perpetual false-positive `destinationGas` violations in `check-warp-deploy` on chains that have no IGP to consume the value. A genuinely configured (non-zero) on-chain destinationGas still surfaces as a violation.
