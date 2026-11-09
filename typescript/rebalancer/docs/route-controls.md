# Route controls

`enabled: false` excludes an economic origin-to-destination proposal from strategy allocation. Destination overrides take precedence over the origin default. Unknown runtime, chain and override fields are rejected, including misspellings such as `enable`. Deployment metadata is validated separately and removed before runtime parsing.

Allocation can reassign earlier choices to use available enabled pairs, including in the collateral-deficit strategy. That strategy retains its preference for the origin of pending user transfers when enabled capacity permits. Existing tolerance and minimum-transfer filters still apply; this is not an optimizer for arbitrary per-edge minimum amounts.

The flag does not cancel an existing intent, restrict manual execution, or prohibit every physical inventory hop. An economic A-to-B inventory proposal may bridge inventory from C to B, then call `transferRemote` from B to A to lock collateral on B and release it on A. Configuration changes take effect when the service reloads through deployment.

## Physical inventory movements

`inventoryRoutes` controls the actual source and destination of inventory wallet movements. It is separate from strategy route controls: an economic Arbitrum-to-Base proposal can use inventory on Optimism to fund Base, then call `transferRemote` from Base to Arbitrum.

```yaml
inventoryRoutes:
  arbitrum:
    base:
      externalBridge: debridge
      priority: 1
  optimism:
    base:
      enabled: false
```

Each exact source-to-destination entry accepts `enabled`, `externalBridge`, and `priority`. Omitted pairs remain enabled and use the economic route's provider. Omitted priority is zero; higher priorities consume their available funding capacity first, then equal-priority sources are ordered by destination output capacity. Priority allocates funding; independent source transactions may still execute in parallel. If the preferred source cannot fund the full shortfall, other permitted sources fund the remainder. No alternative provider is tried for the same pair.

Explicitly disabled pairs are excluded before quotes and checked again before a new movement is submitted. The configured provider is used for capacity quotes, execution, and settlement tracking. Continued intents resolve physical pair policy for new movements; already-submitted movements retain their recorded provider for status polling. Disabling a pair does not cancel or stop tracking a submitted transfer. Existing inventory already on the deficit chain can still be deposited.

Pair endpoints must exist in the warp route with collateral-backed tokens and matching inventory signer configuration. They are monitored even if they have no strategy surplus or deficit. This supports funded neutral sources; it does not create dependent intermediate hops through empty wallets.

Unknown pair fields, self-directed movements, invalid priorities, and unconfigured providers are rejected. Existing configurations without `inventoryRoutes` retain their behavior. Policy changes take effect on service redeployment, using the existing in-memory action tracking.

## Persisting observation mode

Infra configuration can persist observation mode outside the runtime configuration:

```yaml
deployment:
  monitorOnly: true
```

The deployment script combines this setting with `--monitor-only`: either true keeps execution disabled. An ordinary redeployment, including an explicit false CLI flag, cannot override configured observation mode. Remove or change the configuration setting to enable execution. Omitted settings preserve the existing execution default.

Explicit-route rendering uses the selected registry revision without loading unrelated environment configurations. CLI registry overrides remain supported; logs show the configured, overridden, and effective revision. Immutable registry commits and image digests provide reproducible deployments.
