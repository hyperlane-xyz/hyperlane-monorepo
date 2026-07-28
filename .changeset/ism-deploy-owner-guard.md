---
'@hyperlane-xyz/sdk': patch
---

`HyperlaneIsmFactory` now asserts the expected owner when a routing ISM deploy finds its target contract already initialized, instead of silently treating any existing initialization as success. This surfaces contention on a routing ISM's one-time `initialize()` call as a loud failure rather than a silent no-op.
