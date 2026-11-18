# oUSDT production rollout

Only deploy `oUSDT/production`. Its optional `deployment` metadata in
`production-config.yaml` selects the image tag/digest, shared swaps.xyz secret,
registry commit, and persisted monitor-only mode. A digest takes precedence over the tag. Other routes keep
the shared image and credential defaults. Deployment metadata is stripped from
the runtime ConfigMap.

The checked-in image was built from merged main at `f18b00f` and is pinned by digest.
It remains a monitor-only validation candidate. Complete the gates below before
enabling execution.

From `typescript/infra`, render a manifest without cluster queries or mutations:

```sh
pnpm tsx scripts/rebalancer/deploy-rebalancer.ts -e mainnet3 \
  --warp-route-id oUSDT/production --render > /tmp/ousdt.yaml
```

Rendering resolves route membership and RPC-secret chains from the same registry
commit used by the runtime:
`aa7cc3d836cbb020a3cedab7c470d5c59824a269`. The pin includes 17 route chains;
the strategy manages only Ethereum, Arbitrum, Celo, and Tron. All pinned route
chains remain monitored and require their RPC secrets.

The manifest test checks the generated RPC secret references. To verify Tea's
endpoint, require two complete monitor-only polls across all 17 chains using
the configured production secrets. The previous Tea endpoint failed DNS on
November 17, 2026. On November 18 the replacement pod passed this check and
proposed a 2,904.430156 USDT refill for Arbitrum.

Before replacement, archive Helm values/manifests, the live ExternalSecret,
resolved image digest, ConfigMap and `/state/tracking` files. Some archived manifests
reference the former route-specific key. Check the manifest before rollback and
preserve `mainnet3-swapsxyz-api-key` when restoring a release.

Reconcile all stored user transfers against their destination routers'
mailboxes. Separately prove every rebalancer-owned source submission is settled
or definitively unbroadcast. Ambiguity blocks replacement. The selected action
tracker is in memory: `intentTTL: 1209600` neither survives restart nor permits
retrying an ambiguous or source-started submission after expiry. The new release
has no `stateStore` or persistence values; never restore stale tracking files.

Refresh strategy collateral immediately before rollout. Count Ethereum's
lockbox collateral once. Ethereum has a 10,000 minimum and 20,000 target;
Arbitrum, Celo and Tron each retain 1,000/3,000. Aggregate targets are 29,000.
Halt if aggregate collateral is insufficient. Ethereum is replenished only
below its minimum, toward its target; the target is not an instruction to drain
Ethereum to 20,000. Collateral above the minimum can fund other legs' deficits.

The relayer-denylist middleware reads the live mainnet denylist every 60 seconds
and excludes blocked user transfers from collateral demand. Only explicit
message-ID rules affect rebalance accounting; reconcile settlement before
adding a rebalancer-owned message. Inventory reservations are retained.
Startup requires a valid denylist; refresh failures retain the last good rules.

Economic routes into Ethereum from Arbitrum or Tron use USDT/OFT inventory through
LayerZero. Ethereum's router does not support movable collateral and is not
enrolled as a movable-collateral recipient. Arbitrum-to-Tron and Tron-to-Arbitrum
retain movable collateral; Ethereum-origin routes use inventory, and Celo uses
swaps.xyz. The Celo-to-Tron and Tron-to-Celo
`enabled: false` overrides suppress economic strategy proposals. Matching
`inventoryRoutes` entries also disable physical inventory movement in both
directions, including funding for another enabled proposal. Other inventory
pairs retain their existing policy. All provider quote-loss
caps are 50 bps. Validate provider access and executable quotes separately:
monitor-only startup skips executor construction and cannot validate execution
credentials or quotes.

Verify the swaps.xyz credential at rollout and after the first hourly refresh.
Check that the ExternalSecret synced the intended remote key to its Kubernetes
Secret. Compare the synced value with the running container's `SWAPSXYZ_API_KEY`
without printing either value. From inside that container, request a read-only
quote and check its protocol fee against the expected rate for the key.
Environment variables are loaded at container startup. If the values differ,
reconcile in-flight submissions, replace the singleton after synchronization,
then repeat the comparison and quote.

Stop the old singleton after a completed cycle and audit shutdown submissions.
Never overlap execution-enabled instances. After all gates pass, deploy the
candidate with the command above without `--render`. Check fresh balances,
credentials, correct digest/configuration, and zero submissions. Then enable
execution by changing the reviewed YAML to `deployment.monitorOnly: false`,
then redeploy without `--monitor-only`. The CLI can force monitoring on;
`--no-monitor-only` cannot override a persisted `true`. Observe for at least 70
minutes, including the hourly ExternalSecret refresh: require zero restarts,
continuing polls, the shared swaps.xyz credential and no new execution or settlement
failures. Track existing velo metrics errors separately.

Validate the first naturally required rebalance through destination settlement
and post-execution balances. If none occurs within 24 hours, record execution
validation as pending; do not force a transfer.

On startup/credential/configuration failure, repeated failed cycles, unsafe
quotes or approvals, duplicate submission, or incorrect settlement: stop new
submissions, capture and reconcile exposed transactions, then restore the
archived baseline image/configuration with the shared swaps.xyz secret.
Never restart automatically with ambiguous transfers outstanding.
