# Route controls

`enabled: false` excludes an economic origin-to-destination proposal from strategy allocation. Destination overrides take precedence over the origin default. Unknown runtime, chain and override fields are rejected, including misspellings such as `enable`. Deployment metadata is validated separately and removed before runtime parsing.

Allocation can reassign earlier choices to use available enabled pairs, including in the collateral-deficit strategy. That strategy retains its preference for the origin of pending user transfers when enabled capacity permits. Existing tolerance and minimum-transfer filters still apply; this is not an optimizer for arbitrary per-edge minimum amounts.

The flag does not cancel an existing intent, restrict manual execution, or prohibit every physical inventory hop. An economic A-to-B inventory proposal may bridge inventory from C to B, then call `transferRemote` from B to A to lock collateral on B and release it on A. Configuration changes take effect when the service reloads through deployment.

## Persisting observation mode

Infra configuration can persist observation mode outside the runtime configuration:

```yaml
deployment:
  monitorOnly: true
```

The deployment script combines this setting with `--monitor-only`: either true keeps execution disabled. An ordinary redeployment, including an explicit false CLI flag, cannot override configured observation mode. Remove or change the configuration setting to enable execution. Omitted settings preserve the existing execution default.

Explicit-route rendering uses the selected registry revision without loading unrelated environment configurations. CLI registry overrides remain supported; logs show the configured, overridden, and effective revision. Immutable registry commits and image digests provide reproducible deployments.
