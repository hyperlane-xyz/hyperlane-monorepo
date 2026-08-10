---
'@hyperlane-xyz/aleo-sdk': patch
---

The Aleo warp token reader no longer throws when a v1 token is absent from token_registry.aleo. Decimals now fall back to the authoritative app_metadata.local_decimals value and name/symbol degrade to empty strings on a registry miss, so legacy synthetics (e.g. USAD) can be read by check-warp-deploy. The fallback is scoped to a genuine registry miss only; v2 ARC-20 read failures and RPC/transport/decode errors continue to propagate rather than being masked as healthy. The miss stays recoverable so an empty read is retried across the bounded budget — covering a just-registered mapping that has not finalized/indexed yet — and only falls back once those retries are exhausted. The exception boundary is covered by unit tests.
