---
'@hyperlane-xyz/tron-sdk': patch
---

TronWallet now uses the provided RPC URL's host for building, signing and broadcasting transactions instead of silently redirecting non-TronGrid/localhost hosts to the public https://api.trongrid.io endpoint. This fixes private/custom Tron RPCs being ignored for broadcasting (which caused rate-limiting/429s and leaked transactions to a third party). API keys via `custom_rpc_header` continue to work. As an intended behavior change, an RPC that serves eth JSON-RPC but not the Tron HTTP API (`/wallet/*`) will now fail loudly instead of silently succeeding by routing broadcasts through public TronGrid; such setups should point the RPC at a full Tron HTTP API host (or TronGrid with an API key via `custom_rpc_header`).
