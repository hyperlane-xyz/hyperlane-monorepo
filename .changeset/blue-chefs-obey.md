---
'@hyperlane-xyz/infra': minor
'@hyperlane-xyz/sdk': minor
---

New check: HyperlaneRouterChecker now compares the list of domains
the Router is enrolled with against the warp route expectations.
It will raise a violation for missing remote domains.
`check-deploy` and `check-warp-deploy` scripts use this new check.
