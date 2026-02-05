---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
'@hyperlane-xyz/infra': patch
---

Added reusable transaction parsing utilities to the SDK for decoding Safe and Squads multisig transactions. The SDK now exports:

- Safe parsing: `parseSafeTx`, `decodeMultiSendData`, `getSafeTxStatus`, `getOwnerChanges`, `formatFunctionFragmentArgs`, `formatOperationType`, `metaTransactionDataToEV5Transaction`, `asHex`
- Squads parsing: `decodeSquadsPermissions`, `getSquadsTxStatus`, `isVaultTransaction`, `isConfigTransaction`, `formatSquadsConfigAction`
- Types: `SafeTxStatus`, `SafeTxMetadata`, `SafeTxBuilderFile`, `SafeTxBuilderFileSchema`, `ParsedTransaction`, `SquadsTxStatus`, `SquadsProposalStatus`, `SquadsProposalMetadata`, and related enums/constants

The CLI now includes `hyperlane parse safe` and `hyperlane parse squads` commands for decoding pending multisig transactions.

The infra package was refactored to use the SDK's transaction parsing utilities instead of duplicating the logic.
