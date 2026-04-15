---
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/sealevel-sdk': major
'@hyperlane-xyz/starknet-sdk': major
'@hyperlane-xyz/aleo-sdk': major
'@hyperlane-xyz/tron-sdk': major
---

Core query methods (getIsmType, getRoutingIsm, getHookType, etc.) were removed from the IProvider interface and extracted into standalone query functions in each SDK. isMessageDelivered was kept on the interface to enforce all providers implement it.

Starknet get*Transaction methods were extracted into standalone tx builder functions (mailbox-tx.ts, ism-tx.ts, hook-tx.ts, warp-tx.ts) with their own parameter types, removing the dependency on provider-sdk Req/Res types.

Tron and Aleo providers and signers had all get*Transaction and action methods removed. Old e2e tests replaced with artifact API equivalents.

76 Req/Res types were removed from provider-sdk altvm.ts, reducing it from 587 to 243 lines.
