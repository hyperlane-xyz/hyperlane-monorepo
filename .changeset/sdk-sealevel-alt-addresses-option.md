---
"@hyperlane-xyz/sdk": minor
---

`WarpCoreConfigSchema.options.sealevel.altAddresses` was added: an optional `Record<ChainName, { core: string; warpSpecific: string[] }>` map for tracking the Sealevel Address Lookup Tables associated with a warp route. `core` is the chain-shared ALT; `warpSpecific` lists the warp-route-specific ALTs. The field is scoped under `options.sealevel` to leave room for future Sealevel-only options without polluting the protocol-agnostic top level.
