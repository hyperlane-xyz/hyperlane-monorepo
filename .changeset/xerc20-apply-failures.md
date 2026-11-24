---
'@hyperlane-xyz/cli': minor
---

`xerc20 apply` reported that no updates were needed, or that its changes were applied, and exited 0 when the update of a chain had failed. It then exited 1 instead, submitted no transaction and named the failed chains, and `xerc20 read` exited 1 without printing any limits when a chain could not be read.
