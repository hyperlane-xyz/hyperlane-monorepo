---
'@hyperlane-xyz/sdk': patch
---

Added `ccipReadAllowedDomains` to relayer configuration. CCIP reads now require an explicitly allowed HTTPS hostname. The relayer drops a message when the allowlist blocks every way to satisfy its ISM.
