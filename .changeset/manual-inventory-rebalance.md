---
'@hyperlane-xyz/rebalancer': minor
'@hyperlane-xyz/cli': minor
---

Added manual one-shot inventory rebalancing. `hyperlane warp rebalancer --manual --executionType inventory` builds an inventory route for any origin/destination leg on the warp route (including legs absent from the strategy config), forces inventory component creation with signers derived from `HYP_INVENTORY_KEY_<PROTOCOL>` environment variables, synthesizes the swaps.xyz bridge configuration from `SWAPSXYZ_API_KEY` when requested, and polls the rebalance intent to completion with a configurable timeout instead of returning fire-and-forget.
