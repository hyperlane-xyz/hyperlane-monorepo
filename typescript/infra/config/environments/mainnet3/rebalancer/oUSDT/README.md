# oUSDT production rollout

Only deploy `oUSDT/production`. Its optional `deployment` metadata in
`production-config.yaml` selects the image tag/digest, dedicated swaps.xyz secret,
and registry commit. A digest takes precedence over the tag. Other routes keep
the shared image and credential defaults. Deployment metadata is stripped from
the runtime ConfigMap.

The checked-in image is the archived baseline, **not a rollout candidate**. Keep
the configuration PR in draft until the runtime stack through #9361 is merged,
its amd64 image is built with passing CI, and both image references are updated.

From `typescript/infra`, render a manifest without cluster queries or mutations:

```sh
pnpm tsx scripts/rebalancer/deploy-rebalancer.ts -e mainnet3 \
  --warp-route-id oUSDT/production --monitor-only --render > /tmp/ousdt.yaml
```

Rendering resolves route membership and RPC-secret chains from the same registry
commit used by the runtime:
`0b7518b88967309b0ca30827ec418852873bdc7e`.

Before replacement, archive Helm values/manifests, the live ExternalSecret,
resolved image digest, ConfigMap and `/state/tracking` files. Revision 5's saved
manifest uses the generic swaps.xyz secret; the live mapping is
`mainnet3-swapsxyz-api-key-ousdt`. Do not run an unqualified Helm rollback.

Reconcile the ten stored user transfers against their destination routers'
mailboxes. Separately prove every rebalancer-owned source submission is settled
or definitively unbroadcast. Ambiguity blocks replacement. The selected action
tracker is in memory: `intentTTL: 1209600` neither survives restart nor permits
retrying an ambiguous or source-started submission after expiry. The new release
has no `stateStore` or persistence values; never restore stale tracking files.

Refresh strategy collateral immediately before rollout. Count Ethereum's
collateral once. Ethereum must retain its 640,000 minimum and 650,000 target;
Arbitrum, Celo and Tron each retain 1,000/3,000. Aggregate collateral must be
strictly above the 659,000 aggregate target. Halt if insufficient.

Validate provider access and executable quotes separately. Monitor-only startup
skips executor construction and cannot validate execution credentials or quotes.

Stop the old singleton after a completed cycle and audit shutdown submissions.
Never overlap execution-enabled instances. After all gates pass, deploy the
candidate with the command above without `--render`. Check fresh balances,
credentials, correct digest/configuration, and zero submissions. Then enable
execution for this release with `--no-monitor-only`. Observe for at least 70
minutes, including the hourly ExternalSecret refresh: require zero restarts,
continuing polls, stable dedicated credentials and no new execution or settlement
failures. Track existing velo metrics errors separately.

Validate the first naturally required rebalance through destination settlement
and post-execution balances. If none occurs within 24 hours, record execution
validation as pending; do not force a transfer.

On startup/credential/configuration failure, repeated failed cycles, unsafe
quotes or approvals, duplicate submission, or incorrect settlement: stop new
submissions, capture and reconcile exposed transactions, then restore the
archived baseline image/configuration while preserving the dedicated secret.
Never restart automatically with ambiguous transfers outstanding.
