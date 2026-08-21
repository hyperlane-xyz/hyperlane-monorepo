---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/relayer': minor
'@hyperlane-xyz/cli': patch
---

Wormhole hook/ISM routers were added:

- `WormholeExecutorHookIsm` and `WormholeVaaHookIsm` were implemented as combined hook/ISM routers over a shared `AbstractWormholeHookIsm` base. One contract was deployed per chain and enrolled every remote router by Hyperlane domain, so the same local address served as an application's outbound hook and inbound ISM.
- Both published a fixed 224-byte `WormholeMessage` envelope through Wormhole Core, copied the Hyperlane nonce into the signed Wormhole nonce, and bound each VAA to an exact origin domain, Wormhole chain ID, enrolled router address, consistency level, local destination, and message ID.
- `WormholeExecutorHookIsm` bought Executor delivery and preauthorized the message through a permissionless `executeVAAv1` callback, verifying later with empty metadata. `WormholeVaaHookIsm` obtained the VAA through the existing CCIP-read metadata path and verified it inside `Mailbox.process`.
- `IPostDispatchHook.HookTypes` gained an appended `WORMHOLE` member.
- The SDK gained `EvmWormholeHookIsmModule`, paired hook/ISM schemas, recursive config validation, and readers. `warp deploy` and `warp apply` predeployed or reconciled a full mesh, then replaced both leaves with the same local address before generic Warp processing.
- The relayer gained empty metadata for the Executor variant and CCIP-read metadata for the direct-VAA variant. CCIP-read POST requests included `origin_tx_hash` so a lookup service could find the origin event without the Explorer.
- `WormholeExecutorHookIsm` requested Executor delivery with the callback gas limit stored for the destination at enrollment. Hook metadata did not override it, because `StandardHookMetadata.gasLimit` carries the destination `handle` budget priced by the IGP rather than the gas needed to verify a VAA.
