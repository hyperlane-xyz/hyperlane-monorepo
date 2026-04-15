---
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/sealevel-sdk': major
'@hyperlane-xyz/cosmos-sdk': major
'@hyperlane-xyz/radix-sdk': major
'@hyperlane-xyz/starknet-sdk': major
'@hyperlane-xyz/aleo-sdk': major
'@hyperlane-xyz/tron-sdk': major
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/cli': major
---

IProvider and ISigner interfaces were slimmed to their minimal surface. IProvider was reduced from 53 to 22 query-only methods by removing all get*Transaction methods. ISigner was reduced from 36 to 5 infrastructure methods by removing all action methods (createMailbox, setDefaultIsm, enrollRemoteRouter, etc.). Transaction building is now handled exclusively by artifact managers using concrete class methods or standalone helper functions.

Throwing stubs were removed from SVM, Cosmos, Radix, and Starknet provider/signer implementations. Old action-method-based e2e tests were replaced with artifact API equivalents. Cosmos routing ISM writer was fixed to handle domain route updates correctly via remove + re-add.
