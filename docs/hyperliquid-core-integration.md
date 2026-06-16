# Hyperliquid Core integration primitives

HyperEVM is already a Hyperlane domain, but HyperCore balances are not directly controlled by Hyperlane messages. The useful primitives for a Nexus/warp integration live at the HyperCore <> HyperEVM boundary.

## Transfer boundary

- Read precompiles expose Core state and do not move funds.
- CoreWriter is the HyperEVM -> HyperCore action path. A contract calling CoreWriter acts for that contract's own HyperCore account.
- HyperCore -> HyperEVM credits linked assets through protocol transfers. It does not execute arbitrary calldata against HyperEVM contracts.
- Generic linked spot assets use token system addresses. Recipient-aware Core deposits are asset-specific; Circle's USDC `CoreDepositWallet.depositFor` is the clean first target.

## Contract primitives in this repo

- `ICoreWriter` exposes `sendRawAction(bytes)`.
- `HyperliquidCoreWriter` encodes the action headers and ABI payloads for:
  - action `6`, spot send
  - action `13`, send asset
- `ICoreDepositWallet` exposes Circle's USDC deposit entry points used to credit HyperCore users from HyperEVM.

These are intentionally lower-level than a full adapter. A production adapter still needs intent storage for any asynchronous Core -> EVM -> warp flow and should only claim direct user credit for assets whose HyperEVM -> Core path supports an explicit recipient.
