---
'@hyperlane-xyz/scraper-proxy': patch
---

Shared message reader rollbacks were narrowed to rows with a fact the rollback can change, and gas payment buckets were capped per paying domain: the oldest and newest heights stay exact and the middle folds into one bucket, so a frontier inside a fold returns partial totals instead of a payment-baseline error.
