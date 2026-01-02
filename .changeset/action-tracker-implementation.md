---
'@hyperlane-xyz/rebalancer': minor
---

Implemented ActionTracker for inflight-message-aware rebalancing. The ActionTracker tracks three entity types: user warp transfers (Transfer), rebalance intents (RebalanceIntent), and rebalance actions (RebalanceAction). It provides startup recovery by querying the Explorer for inflight messages, periodic sync operations to check message delivery status on-chain, and a complete API for creating and managing rebalance intents and actions. The implementation includes a generic store interface (IStore) with an InMemoryStore implementation, comprehensive unit tests, and integration with ExplorerClient for querying inflight messages.
