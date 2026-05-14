---
"@hyperlane-xyz/sdk": minor
---

`WarpCoreConfigSchema.options.svmAltAddresses` was added: an optional `Record<ChainName, { core: string; warpSpecific: string[] }>` map for tracking the SVM Address Lookup Tables associated with a warp route. `core` is the chain-shared ALT; `warpSpecific` lists the warp-route-specific ALTs.
