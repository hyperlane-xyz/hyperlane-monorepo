---
"@hyperlane-xyz/scraper-proxy": minor
---

Removed historical agent WebSocket backfills, replay cursors, catch-up frames and metrics, and the subscription metric's state label. Limited agent frames to 64 KiB and documented per-type, mid-range live starts and the required RPC overlap.

Required deployment of the validator and relayer RPC-recovery refactors (#10038 and #10039), or explicit RPC-only configuration for older agents, before the proxy upgrade. Accepted the metrics compatibility break; the single affected dashboard will be updated separately. Kept public endpoint exposure and the central snapshot service as separate follow-ups.
