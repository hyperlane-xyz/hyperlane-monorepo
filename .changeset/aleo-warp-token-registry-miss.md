---
'@hyperlane-xyz/aleo-sdk': patch
---

The Aleo warp token reader no longer throws when a v1 token is absent from token_registry.aleo. Decimals now fall back to the authoritative app_metadata.local_decimals value and name/symbol degrade to empty strings on a registry miss, so legacy synthetics (e.g. USAD) can be read by check-warp-deploy.
