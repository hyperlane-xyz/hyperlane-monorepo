---
'@hyperlane-xyz/sdk': major
---

Added Predicate integration for compliance-gated warp route transfers

- Added `PredicateWrapperConfigSchema` for configuring predicate wrapper deployment
- Added `PredicateApiClient` for fetching attestations from Predicate API
- Added `PredicateWrapperDeployer` for deploying and configuring PredicateRouterWrapper contracts
- Integrated predicate wrapper deployment into warp route deployment flow
- Supported aggregation hooks with predicate wrapper (wrapper executes first)
- Always aggregated predicate wrapper with mailbox default hook to ensure gas quoting works correctly
- Detected PredicateRouterWrapper recursively inside nested aggregation hooks

Example configuration:
```yaml
ethereum:
  type: collateral
  token: '0x...'
  predicateWrapper:
    predicateRegistry: '0xe15a8Ca5BD8464283818088c1760d8f23B6a216E'
    policyId: 'x-your-policy-id'
```
