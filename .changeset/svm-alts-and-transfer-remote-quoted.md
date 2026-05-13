---
'@hyperlane-xyz/sealevel-sdk': minor
---

SVM Address Lookup Table (ALT) support and the public transfer-remote instruction builders needed to drive offchain-quoted fees + quoted IGP gas payments were added.

`SealevelAddressLookupTableReader` / `SealevelAddressLookupTableWriter` were introduced as an `ArtifactReader`/`Writer` pair over the on-chain ALT program. The writer's `create()` chunks extends, optionally freezes, and polls for activation (`tx_slot > last_extended_slot`) before returning so callers can use the new ALT in the very next tx. `update()` is idempotent — it computes the address diff (set-based, append-only), returns `[]` when the on-chain state already matches expected, and throws only when the requested mutation is unsatisfiable. The config shape is `{ frozen: boolean, addresses: Address[] }`; the on-chain authority is surfaced read-only via `SealevelDeployedAlt.authority`. `SealevelTransaction.addressLookupTables` accepts a plain `Address[]` of ALT pubkeys — the signer fetches each table's entries (`concurrentMap`) and assembles kit's `AddressesByLookupTableAddress` internally, then threads it through both `buildTransactionMessage` and `transactionToPrintableJson` (the Squads / offline-signing path previously inlined ALT-resolvable accounts and could exceed the 1232-byte packet limit).

`getTokenTransferRemoteInstruction` (collateral / native / synthetic) and `getCrossCollateralTransferRemoteToInstruction` were added as public builders. Both accept optional `fee` and `igp.quoted` sections; the IGP section supports Legacy and Quoted modes against both `Igp` and `OverheadIgp` types, with the warp's sender program id captured in `IgpQuotedExtension.senderProgramId`. The CC remote path now correctly uses the mailbox dispatch authority (the CC-specific dispatch authority is for the local `HandleLocal` CPI path only), and the CC state PDA is marked readonly.

`@solana-program/address-lookup-table` was added as a runtime dependency.
