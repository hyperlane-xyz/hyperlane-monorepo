---
'@hyperlane-xyz/sdk': patch
---

assertCodeExists now retries getCode with backoff to tolerate RPC lag where a just-confirmed contract is not yet visible across all nodes in a load-balanced pool.
