---
'@hyperlane-xyz/scraper-proxy': patch
---

Shared message reader failures were made non-disconnecting: a failed domain read backs off without failing subscribers, rollback-invalidated reads are retried, rollbacks only invalidate cached facts that read the rolled-back domain, facts still waiting for transaction rows are reread, unwanted reads are no longer cached as missing messages, delivery updates reach subscribers of other domains again, and projection errors send a per-message error frame to global streams.
