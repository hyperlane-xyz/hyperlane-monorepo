---
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/relayer': patch
'@hyperlane-xyz/utils': patch
---

Fixed monitor shutdown ownership, relayer retry scheduling and restart ownership, and lazy initialization recovery so overlapping lifecycle transitions could not duplicate polling, block the event loop, or permanently cache a retryable synchronous failure.
