---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/keyfunder': patch
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/relayer': patch
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/utils': patch
'@hyperlane-xyz/widgets': patch
---

Fixed retryable initialization, shutdown draining, deployment failure accounting, provider health polling, and widget request ownership. Preserved confirmed and uncertain batch progress on submission failures and prevented automatic replay of transaction phases after partial submission or artifact-write errors.
