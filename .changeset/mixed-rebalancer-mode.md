---
'@hyperlane-xyz/rebalancer': major
---

Mixed-mode rebalancing was added to enable simultaneous movable collateral (EVM) and inventory (multi-VM) execution within a single rebalancer configuration, enabling cross-protocol rebalancing across EVM and Sealevel chains.

**BREAKING CHANGES:**

- `inventorySigner` config field was replaced with `inventorySigners`, a per-protocol map (`Partial<Record<ProtocolType, { address: string; key?: string } | string>>`). Existing configs using `inventorySigner` must migrate to the new schema.
- `IExternalBridge.execute()` signature changed from `(quote, privateKey: string)` to `(quote, privateKeys: Partial<Record<ProtocolType, string>>)`. All `IExternalBridge` implementations must update their `execute` method to accept the new multi-protocol key map.

**New features:**

- Per-protocol signer architecture supporting EVM + Sealevel keys simultaneously.
- `transferRemote` execution refactored to use `WarpCore.getTransferRemoteTxs()` for multi-VM compatibility, with protocol-aware receipt parsing and `SealevelCoreAdapter.parseMessageDispatchLogs` for Sealevel message ID extraction.
- LiFi bridge extended with Sealevel support via `KeypairWalletAdapter`, Hyperlane domain ID to LiFi chain ID translation, and mutex around configure+execute to prevent race conditions.
- Startup validation for signer coverage against all inventory route protocols, per-protocol address format validation, and Solana pubkey cross-check.
- `parseSolanaPrivateKey()` utility with strict 64-byte validation and base58 normalization.
- Zod schemas hardened for strategy configs, external bridges, and inventory signers with per-protocol address validation.
- Private key redaction in log statements and EVM-only filtering for Explorer signer addresses.
