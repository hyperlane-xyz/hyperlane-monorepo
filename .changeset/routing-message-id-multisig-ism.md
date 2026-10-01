---
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/cli': minor
---

Added the Sealevel-only `routingMessageIdMultisigIsm` ISM type, a single deployment holding an independent message-id multisig (validators and threshold) per origin domain, keyed by chain name in config.

- `@hyperlane-xyz/sealevel-sdk`: the ISM artifact manager reads and writes the new type with `SealevelRoutingMessageIdMultisigIsmReader` and `SealevelRoutingMessageIdMultisigIsmWriter` from the known domain ids it is given, and reports a deployed multisig ISM program as the new type. The flat `messageIdMultisigIsm` type is rejected with an error pointing at the new one.
- `@hyperlane-xyz/provider-sdk`: `IsmType.ROUTING_MESSAGE_ID_MULTISIG` and `RoutingMessageIdMultisigIsmConfig` were added to the ISM config union, and `createIsmArtifactManager` accepts an optional context carrying a non-empty `knownDomainIds` array. A new ISM is deployed when the expected config drops a domain that exists on chain, since the program cannot remove one. Only domains of chains known to the `ChainLookup` are detected, since the program's domain accounts cannot be enumerated. A new ISM is also deployed when the on-chain owner was renounced and the expected domains or owner differ, since the ISM can no longer be updated. `ChainLookup` gained a required `getKnownDomainIds` member returning the set of domain ids of all known chains. The shared `assertValidDomainRoutingMultisig` validator was added for a single domain's threshold and duplicate-validator invariants. Converting a config with a chain name unknown to the `ChainLookup` into an artifact now throws instead of skipping the domain.
- `@hyperlane-xyz/deploy-sdk`: ISM validation accepts the new type on Sealevel only and rejects the flat `messageIdMultisigIsm` type there up front, and the known domain ids from `ChainLookup.getKnownDomainIds()` are passed to the ISM artifact manager.
- `@hyperlane-xyz/sdk`: `IsmType.ROUTING_MESSAGE_ID_MULTISIG` was added with `RoutingMessageIdMultisigIsmConfig` and `RoutingMessageIdMultisigIsmConfigSchema` as new `IsmConfig` members. The EVM ISM factory rejects the type. `altVmChainLookup` and `ChainMetadataResolver` expose `getKnownDomainIds`.
- `@hyperlane-xyz/cli`: `warp deploy`, `warp apply`, `warp read`, `warp check` and `core deploy` work with the new ISM from config files. Removing a domain from the config deploys a fresh ISM and repoints the router.
