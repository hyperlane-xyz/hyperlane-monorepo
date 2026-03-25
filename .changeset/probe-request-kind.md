---
'@hyperlane-xyz/sdk': patch
---

Probe-specific SmartProvider request handling was added so contract-shape probes can short-circuit deterministic misses without using the normal read retry loop, while transport failures still fall through to other providers.
