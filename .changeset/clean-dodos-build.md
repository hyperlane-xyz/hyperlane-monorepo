---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/http-registry-server': minor
'@hyperlane-xyz/sdk': patch
---

The temporary Zod 3 registry compatibility layer was removed after adopting the registry's Zod 4 schemas. Repeated server and config validators are now compiled once, and boolean-only checks use Zod's allocation-free validation path.
