---
"@hyperlane-xyz/sdk": patch
---

Fix SmartProvider to retry on CALL_EXCEPTION errors without revert data. Previously, CALL_EXCEPTION errors would immediately stop provider fallback even when caused by RPC issues rather than actual on-chain reverts. Now, CALL_EXCEPTION errors without revert data (or with empty "0x" data) are treated as transient RPC errors and will trigger fallback to the next provider.
