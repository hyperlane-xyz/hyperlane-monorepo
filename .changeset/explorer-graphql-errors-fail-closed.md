---
'@hyperlane-xyz/rebalancer': patch
---

Explorer GraphQL errors returned with HTTP 200, and responses without `message_view` rows, were made to fail the query instead of being read as an empty result.
