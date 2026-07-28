---
'@hyperlane-xyz/sdk': patch
---

Removed the acquired Imperator validator from the ink default multisig ISM config, where it has been frozen (checkpoint stuck at index 129000), and lowered the ink threshold from 4 to 3 to preserve the minimum majority (`floor(n/2) + 1`). Imperator remains in the other default ISMs pending a planned batch rotation.
