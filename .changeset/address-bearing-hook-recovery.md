---
'@hyperlane-xyz/sdk': minor
---

Added safe recovery for address-bearing hook trees. Recovered pausable hooks and ISMs can transfer ownership without redeployment, while recovery validates the complete tree before mutation, preserves live pause state, and rejects incorrect contract types or conflicting aliases.
