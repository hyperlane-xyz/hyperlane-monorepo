---
'@hyperlane-xyz/sdk': patch
---

Missing-selector detection was fixed to stop classifying RPC transport failures (HTTP errors, dropped connections, JSON-RPC errors such as "header not found") as an absent selector. Ethers wraps these as `CALL_EXCEPTION` with `data="0x"` and the original error nested, so `isMissingSelectorRevert` now matches only an empty return with no nested error or a nested execution revert (JSON-RPC code 3 or a revert message), and warp route reader probes surface an RPC outage instead of silently taking the "unsupported" default.
