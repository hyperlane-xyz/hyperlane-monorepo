---
'@hyperlane-xyz/cli': patch
---

`hyperlane warp alt create` was hardened after review:

- Frozen ALTs are now persisted under the resolved warp route ID, so symbol-shorthand inputs no longer write to an ID that later `read`/`check` cannot find.
- Token selection was made consistent with `warp alt check` (first entry per chain), so multi-token chains no longer produce false drift.
- Successfully-frozen ALTs are persisted even when a sibling chain fails.
- Re-running a fully-registered route without flags now exits cleanly instead of erroring.
- A `--chain` that is not part of the warp route is now rejected instead of silently exiting 0.
