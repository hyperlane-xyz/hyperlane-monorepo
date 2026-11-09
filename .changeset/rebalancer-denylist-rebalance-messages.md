---
'@hyperlane-xyz/rebalancer': minor
---

The `relayerDenylist` pending transfer middleware was extended to rebalance messages, to which only `match` rules that set nothing but `messageId` apply. Denied rebalance messages are no longer recovered at startup or on later syncs, and a tracked rebalance intent whose in-progress messages are all denied stops counting as incoming collateral without any change to its status, so delivery checks and the intent TTL still apply. Broader `match` rules and `address` rules do not affect rebalance accounting, and inventory intents are unaffected. A rebalance message is meant to be denied only after its funds settled another way: an unsettled denied one is replaced by the strategy, and removing or expiring the rule makes it count again. Explorer queries made while a denylist refresh is in progress now wait for it instead of filtering with the previous rules.
