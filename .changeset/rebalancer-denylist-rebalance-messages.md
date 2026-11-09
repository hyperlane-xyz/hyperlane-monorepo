---
'@hyperlane-xyz/rebalancer': minor
---

The `relayerDenylist` pending transfer middleware was extended to rebalance messages. Denied rebalance messages are no longer recovered at startup or on later syncs, and a tracked rebalance intent whose in-progress messages all become denied stops counting as incoming collateral without any change to its status, so delivery checks and the intent TTL still apply. Inventory intents are unaffected. Explorer queries made while a denylist refresh is in progress now wait for it instead of filtering with the previous rules.
