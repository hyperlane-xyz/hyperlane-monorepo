---
'@hyperlane-xyz/sdk': patch
---

The warp route `ownerStatus` virtual check no longer recurses into the implementation contract's owner. Under the transparent-proxy pattern the implementation is inert (upgrade authority lives in the ProxyAdmin, not the implementation) and its owner is never a configured value, so a stale deployer EOA there produced false-positive owner-inactive drift. The check still recurses into the ProxyAdmin owner, which holds upgrade authority and is a managed owner.
