---
'@hyperlane-xyz/rebalancer': minor
---

The rebalancer gained a Fluent external bridge that uses Fluent's canonical NativeGateway to move native ETH between Ethereum and Fluent (chainId 25363). Status is read directly from `FluentBridge.getReceivedMessage(messageHash)`; no L1/L2 event log search is required. A new `bridge:direct` script (`src/scripts/bridgeDirect.ts`) lets operators invoke any registered `IExternalBridge` directly without a rebalancer config file. `BridgeTransferStatus.complete`'s `receivingTxHash` and `receivedAmount` fields were made optional since not every bridge needs to populate them.
