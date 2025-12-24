---
"@hyperlane-xyz/sdk": minor
---

Support setting warp route ISM to an existing address. Previously, `warp apply` only accepted ISM configs as objects (for deployment) or zero addresses. Now any ISM address can be specified, allowing warp routes to reuse existing ISM deployments instead of creating duplicates.
