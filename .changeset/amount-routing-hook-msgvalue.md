---
"@hyperlane-xyz/core": patch
---

AmountRoutingHook._postDispatch() was updated to forward msg.value directly to the child hook instead of computing and forwarding the quoted amount, fixing native value handling for ERC20 fee flows.
