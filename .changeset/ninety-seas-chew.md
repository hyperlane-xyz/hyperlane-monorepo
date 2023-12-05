---
'@hyperlane-xyz/cli': patch
---

Allow users to only configure validators for their chain

- Don't restrict user to having two chains for ism config
- If the user accidentally picks two chains, we prompt them again to confirm if they don't want to use the hyperlane validators for their multisigConfig
