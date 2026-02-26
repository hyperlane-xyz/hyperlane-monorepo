---
'@hyperlane-xyz/sdk': minor
---

Add Predicate integration for compliance-gated warp route transfers

- Add `PredicateWrapperConfigSchema` for configuring predicate wrapper deployment
- Add `PredicateApiClient` for fetching attestations from Predicate API
- Add `PredicateWrapperDeployer` for deploying and configuring PredicateRouterWrapper contracts
- Integrate predicate wrapper deployment into warp route deployment flow
- Support aggregation hooks with predicate wrapper (wrapper executes first)
- Always aggregate predicate wrapper with mailbox default hook to ensure gas quoting works correctly
- Detect PredicateRouterWrapper recursively inside nested aggregation hooks

Example configuration:
```yaml
ethereum:
  type: collateral
  token: '0x...'
  predicateWrapper:
    predicateRegistry: '0xe15a8Ca5BD8464283818088c1760d8f23B6a216E'
    policyId: 'x-your-policy-id'
```
