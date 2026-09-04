---
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/sealevel-sdk': patch
'@hyperlane-xyz/sdk': minor
---

A composite ISM's `rateLimited.recipient` was resolved from its warp router instead of being hand-written. Tooling derived the value on both deploy and apply because a wrong recipient failed at delivery time indistinguishably from a rate-limit trip. Resolution covered expanded compound artifacts such as `domainRoutingIsm.domains` and composite nodes nested under `aggregation`, `amountRouting`, and `routing`/`fallbackRouting` domain overrides. Exhaustive artifact traversal was added so future compound artifact types must declare their nested ISMs before compiling.

`CompositeIsmConfigSchema` was changed to accept a `rateLimited` node without a `recipient` while continuing to reject an explicitly zero value. `WarpTokenWriter.create` was changed to reject any written-out recipient on a new composite ISM, since the router address only became available during deployment. `WarpTokenWriter.update` was changed to reject a recipient that differed from the router while accepting a matching value, preserving `warp read` → apply idempotency.

AltVM warp routes were created without an ISM, then the configured ISM was resolved and attached through the regular update path, matching the existing fee flow. The high-level SDK preserved declarative AltVM ISM configs for this artifact path instead of pre-deploying them. NEW ISMs were deployed after the router address became available; DEPLOYED and UNDERIVED roots were reused without deployment.

Nested artifact states within a NEW parent were preserved independently: NEW descendants were resolved and deployed, DEPLOYED descendants were validated and retained as references, and UNDERIVED descendants remained opaque. DEPLOYED roots were reused unchanged during warp creation and rejected if their declarative config contained a NEW descendant that would otherwise be silently ignored.

A `rateLimited` node was rejected outright in a mailbox default ISM at two layers: `CoreConfigSchema` failed parsing, and `CoreWriter.create`/`CoreWriter.update` asserted before emitting a transaction. The SDK schema guard used one typed, exhaustive visitor across SDK ISM containers and composite-node containers, while retaining distinct predicates for EVM `rateLimitedIsm` and composite `rateLimited` nodes.

`assertValidCompositeIsmArtifact` in sealevel-sdk continued requiring a non-zero recipient as the last line of defence, and its message was updated to explain automatic warp-route resolution.

provider-sdk gained canonical `IsmType` discriminants plus contextual `resolveIsmArtifact`, `resolveRateLimitedIsmRecipients`, `assertRateLimitedIsmRecipientsUnset`, and `assertIsmSupportedAsMailboxDefault` from `@hyperlane-xyz/provider-sdk/ism`. Contextual address conversion used the shared protocol-detecting `addressToBytes32` utility, keeping provider-sdk free of Sealevel address assumptions.
