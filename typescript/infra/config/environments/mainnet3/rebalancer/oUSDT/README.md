# oUSDT production rollout

Only deploy `oUSDT/production`. Its optional `deployment` metadata in
`production-config.yaml` selects the image tag/digest, dedicated swaps.xyz secret,
registry commit, and persisted monitor-only mode. A digest takes precedence over the tag. Other routes keep
the shared image and credential defaults. Deployment metadata is stripped from
the runtime ConfigMap.

The checked-in image is the archived baseline, **not a rollout candidate**. Build
the branch tip after review and update both image references before rollout.

From `typescript/infra`, render a manifest without cluster queries or mutations:

```sh
pnpm tsx scripts/rebalancer/deploy-rebalancer.ts -e mainnet3 \
  --warp-route-id oUSDT/production --render > /tmp/ousdt.yaml
```

Rendering resolves route membership and RPC-secret chains from the same registry
commit used by the runtime:
`0b7518b88967309b0ca30827ec418852873bdc7e`. The pin includes 17 route chains;
the strategy manages only Ethereum, Arbitrum, Celo, and Tron. All pinned route
chains remain monitored and require their RPC secrets.

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
collateral once. Ethereum must retain its 345,000 minimum and 365,000 target;
Arbitrum, Celo and Tron each retain 1,000/3,000. Aggregate collateral must be
strictly above the 374,000 aggregate target. Halt if insufficient.

The route uses USDT/OFT inventory from Ethereum, movable collateral from
Arbitrum and Tron, and swaps.xyz for Celo. The Celo-to-Tron and Tron-to-Celo
`enabled: false` overrides suppress economic strategy proposals. Physical
inventory sourcing for another enabled proposal can still move inventory between
Celo and Tron when the provider returns a valid quote. All provider quote-loss
caps are 50 bps. Validate provider access and executable quotes separately:
monitor-only startup skips executor construction and cannot validate execution
credentials or quotes.

Stop the old singleton after a completed cycle and audit shutdown submissions.
Never overlap execution-enabled instances. After all gates pass, deploy the
candidate with the command above without `--render`. Check fresh balances,
credentials, correct digest/configuration, and zero submissions. Then enable
execution by changing the reviewed YAML to `deployment.monitorOnly: false`,
then redeploy without `--monitor-only`. The CLI can force monitoring on;
`--no-monitor-only` cannot override a persisted `true`. Observe for at least 70
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
