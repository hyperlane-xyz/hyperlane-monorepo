---
'@hyperlane-xyz/core': minor
---

disabled the ICARouter's ability to change hook given that the user doesn't expect the hook to change after they deploy their ICA account. Hook is not part of the derivation like ism on the destination chain and hence, cannot be configured custom by the user.
