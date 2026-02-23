# inflight-rpc

Purpose: find inflight user/self messages directly from chain RPC/mailbox events.

Inputs:
- `warpRouteIds[]`
- chain metadata

Output JSON:
```json
{ "messages": [{ "messageId": "0x...", "type": "user", "routeId": "...", "origin": "anvil2", "destination": "anvil3", "sourceRouter": "0x...", "destinationRouter": "0x...", "amount": "1000000", "status": "in_progress", "source": "rpc", "txHash": "0x..." }] }
```
