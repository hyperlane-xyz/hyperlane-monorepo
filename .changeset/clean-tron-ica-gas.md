---
'@hyperlane-xyz/sdk': patch
---

ICA fallback gas estimation was updated to use the derived interchain account as the sender, preventing owner-gated fallback estimates from inflating Tron gas quotes.
