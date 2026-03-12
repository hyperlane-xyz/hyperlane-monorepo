---
"@hyperlane-xyz/sdk": minor
---

Added optional `warpRouteId` field to TokenConfigSchema for disambiguating tokens that share the same addressOrDenom on the same chain (e.g. M0 Portal tokens). When present, WarpCore.FromConfig uses it during connection resolution to ensure tokens connect only within their own warp route.
