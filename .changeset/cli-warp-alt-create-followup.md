---
'@hyperlane-xyz/cli': patch
---

`hyperlane warp alt create` was hardened after review: frozen ALTs are now persisted under the resolved warp route ID (so symbol-shorthand inputs no longer write to an ID that later `read`/`check` cannot find), token selection was made consistent with `warp alt check`/`read` (first entry per chain) so multi-token chains no longer produce false drift, successfully-frozen ALTs are persisted even when a sibling chain fails, and re-running a fully-registered route without flags now exits cleanly instead of erroring.
