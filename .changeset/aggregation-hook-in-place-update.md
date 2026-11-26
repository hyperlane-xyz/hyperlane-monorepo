---
'@hyperlane-xyz/sdk': minor
---

Aggregation hook updates were changed to update the members in place and keep the aggregation address when every member keeps its address, instead of redeploying every member and the aggregation. Changing only a member's owner, paused state, capacity or other mutable field no longer replaces the aggregation, so `warp apply` and `core apply` do not set a new hook, and members that did not change are not orphaned. The aggregation is still redeployed when a member cannot be updated in place, for example when the duration of a rate limited member, the max fee of a protocol fee member or the fallback of a fallback routing member changes, when the members or their types do not match, or when a default or merkle tree member that is kept is bound to another mailbox than the one of the module. The transactions of an update are now signed by the owners of the members that change.
