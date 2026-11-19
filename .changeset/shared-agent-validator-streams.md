---
'@hyperlane-xyz/scraper-proxy': patch
---

Shared event reads across connections and confirmation policies within isolated agent and validator sources. Added bounded outbound queues, route-specific byte quotas, and queue metrics. Increased per-proxy connection limits to 500 messages and 2,000 validators while retaining per-IP and setup limits. Limited custom confirmations to 1,000 and agent custom subscriptions to 512 domains and a 10,000 domain-block budget.
