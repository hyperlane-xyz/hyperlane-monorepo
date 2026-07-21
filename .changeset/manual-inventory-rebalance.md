---
'@hyperlane-xyz/rebalancer': minor
'@hyperlane-xyz/cli': minor
---

Manual one-shot inventory rebalancing was added. The attended workflow polls at a fixed interval until completion or timeout, recovers indexed Hyperlane deposits after restart, and requires an operator to verify untracked external bridge transfers before retrying after interruption.
