---
'@hyperlane-xyz/sdk': minor
---

Added end-to-end warp deploy support for the warp-route hybrid hook/ISMs:

- Hook and ISM trees were validated together, token routers were deployed first, and each shared hybrid leaf was then deployed once and installed on both surfaces. Hook installation and readback complete route-wide before ISM installation.
- Delayed-flow counterparts were enrolled before router enrollment and final ownership transfer. In-route peers are derived automatically; configured external `remoteIsms` are retained.
- `warpRouter` became optional in warp-route configs and is injected after the containing router exists. Explicit mismatches are rejected.
- `remoteIsms` keys are canonicalized across deploy, update, read, and check. Route-derived peers override stale configured values for chains in the route, while external configured peers remain authoritative.
- Expanded configs include the deployed shared address, router, and delayed-flow peers so `warp check` converges with the installed route.
