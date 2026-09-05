# Load LiFi only when configured

The factory imported LiFiBridge eagerly, initializing its SDK even for movable-only rebalancers. It now imports the module inside the configured LiFi branch of the existing awaited initialization chain. An external bridge override, including an empty override, still bypasses normal bridge construction. Configured LiFi initialization failures still abort service initialization before monitoring or execution starts.

## Observed deployment coverage

Read-only mainnet3 ConfigMap inspection on 2026-09-05 found 14 rebalancer configurations: four configured a LiFi integrator, ten did not. Nine of those ten had no inventory signer configuration; the other had inventory configuration without a LiFi bridge. No configuration, signer or workload was changed.

## Local measurement

Node 24.13.0, macOS, five alternating fresh-process pairs after one discarded warmup pair, same dependency installation. Each process imported the compiled RebalancerContextFactory module. The baseline was the parent compiled module preserved alongside the changed module so its relative dependencies resolved identically. Node module-load hooks counted LiFi files; no service, RPC, quote or signing operation was run.

| Median                       | Parent     | Lazy import | Difference        |
| ---------------------------- | ---------- | ----------- | ----------------- |
| Factory import wall time     | 1484.18 ms | 1356.74 ms  | -127.44 ms / 8.6% |
| Import CPU time              | 2016.92 ms | 1866.27 ms  | -150.65 ms / 7.5% |
| Resident memory after import | 645.64 MiB | 629.75 MiB  | -15.89 MiB / 2.5% |
| LiFi module loads            | 122        | 0           | -122 / 100%       |

These are local unbundled module-import measurements on a shared host. RSS is current resident memory, not peak memory or retained heap. The percentages are neither deployed startup measurements nor steady-state fleet memory savings. Inventory configurations that need LiFi pay its import cost during initialization.

## Reproduction

Use separate parent and PR checkouts with the same Node version and frozen dependencies. Build workspace dependencies and the rebalancer package, then run the following from each repository root in alternating fresh processes. Discard the first pair and compare at least five pairs. The module-load hook requires a Node release supporting registerHooks (measurement used 24.13.0).

```sh
node --input-type=module <<'JS'
import { registerHooks } from 'node:module';
let lifiModules = 0;
registerHooks({
  load(url, context, nextLoad) {
    if (url.includes('/@lifi/')) lifiModules++;
    return nextLoad(url, context);
  },
});
const started = performance.now();
const cpu = process.cpuUsage();
await import('./typescript/rebalancer/dist/factories/RebalancerContextFactory.js');
console.log(JSON.stringify({
  wallMs: performance.now() - started,
  cpuMs: Object.values(process.cpuUsage(cpu)).reduce((a, b) => a + b, 0) / 1000,
  rssMiB: process.memoryUsage().rss / 1048576,
  lifiModules,
}));
JS
```

## Validation

391 unit tests passed, including configured bridge construction and absent-configuration behavior. Package build and lint passed (three existing warnings). The normal production ncc bundle built and reached its expected missing-config guard with an empty environment, before external operations. A separate offline ncc fixture also exercises the dynamically imported bridge constructor, with empty chain metadata and no quote or signing call. No deployment was performed.

Local runtime imports needed the previously identified ignored node_modules core-js compatibility entry for the pinned Provable SDK; no dependency or lockfile change is included.
