---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cli': patch
---

Fee quoting client and shared types were moved from @hyperlane-xyz/fee-quoting into @hyperlane-xyz/sdk. The fee-quoting package was marked as private since it is a deployable service, not a published library.
