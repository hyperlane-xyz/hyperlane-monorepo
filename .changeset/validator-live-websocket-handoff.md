---
'@hyperlane-xyz/sdk': major
---

Removed lightweight validator mode and its `lightweight` and `leightweigt` configuration fields. Validators now require RPC indexing for historical recovery before handing off to optional live WebSocket insertions. Existing configurations must remove either field, including when set to `false`.

Deferred RPC-free indexing until a supported bootstrap and recovery solution is available, potentially through a future snapshot service.
