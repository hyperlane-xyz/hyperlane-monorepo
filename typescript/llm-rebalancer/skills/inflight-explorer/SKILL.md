# inflight-explorer

Purpose: find inflight user/self messages from Hyperlane Explorer API.

Inputs:
- `warpRouteIds[]`
- explorer endpoint

Output JSON:
```json
{ "messages": [{ "messageId": "0x...", "type": "self", "routeId": "...", "origin": "anvil3", "destination": "anvil2", "sourceRouter": "0x...", "destinationRouter": "0x...", "amount": "500000", "status": "in_progress", "source": "explorer", "txHash": "0x..." }] }
```
