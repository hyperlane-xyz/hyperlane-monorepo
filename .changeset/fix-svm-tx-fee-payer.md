---
"@hyperlane-xyz/sealevel-sdk": patch
---

Fixed serialized transaction output using the local keypair as fee payer instead of the actual authority (e.g. Squads vault). Added explicit feePayer field to SvmTransaction and set it on all update paths. Fixed enrollRemoteRouters and setDestinationGasConfigs to use readonlySignerAddress matching the Rust program spec.
