# Core ownership handoff

`handoff-core-ownership.ts` transfers every Ownable core artifact recorded in
the registry to a final chain owner. It works for chains that are still enabled
in infra and chains removed from `supportedChainNames`.

The script is dry-run by default. It discovers and de-duplicates the canonical
core Ownable addresses, reads owners on-chain, and writes an auditable plan
before any optional execution. Missing labels from older deployments are
recorded in the plan. It supports contracts owned by the environment deployer,
the configured governance ICA, or a configured destination Safe. Any other
owner fails the run.

```yaml
environment: mainnet3
governance:
  origin: ethereum
  type: regular
chains:
  examplechain:
    owner: '0x1111111111111111111111111111111111111111'
```

Generate and review a plan:

```bash
pnpm tsx scripts/core/handoff-core-ownership.ts \
  --config /path/to/handoff.yaml \
  --out /tmp/core-handoff-plan.json
```

Execute deployer-owned calls and propose Safe-owned/ICA-owned calls only after
reviewing the plan. Writes require the exact hash from the reviewed dry run:

```bash
pnpm tsx scripts/core/handoff-core-ownership.ts \
  --config /path/to/handoff.yaml \
  --out /tmp/core-handoff-plan.json \
  --expected-plan-hash 0x... \
  --submit-deployer \
  --propose-safe
```

If a chain has also been removed from the current registry, set `REGISTRY_URI`
to a registry checkout that still contains its metadata and addresses. Missing
secret RPC configuration falls back to public registry RPCs.

Optional per-chain fields:

- `sourceSafe`: Safe currently owning local contracts when it is no longer in
  the environment governance maps.
- `ica.account` and `ica.routerOverride`: legacy ICA validation/routing.
- `additionalContracts`: named addresses absent from the registry.
- `allowContractOwner`: permits a non-Safe contract as the final owner after
  manual verification.

The target may be an EOA, EIP-7702 delegated EOA, Safe, or an explicitly
allowed contract. Two-step Ownable contracts are reported but not submitted;
the target must participate in accepting those transfers. Do not rerun
`--propose-safe` while an earlier proposal is pending; rerun the dry run after
execution to verify the final state. The plan hash includes fully encoded ICA
transactions, including destination domain, router, gas metadata, and value.
