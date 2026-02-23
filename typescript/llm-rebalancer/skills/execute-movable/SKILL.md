# execute-movable

Purpose: execute a single `movableCollateral` action.

Input:
```json
{ "action": { "executionType": "movableCollateral", "routeId": "...", "origin": "...", "destination": "...", "sourceRouter": "0x...", "destinationRouter": "0x...", "amount": "1000000", "actionFingerprint": "..." } }
```

Expected execution:
- Use configured signer.
- Submit `rebalance` path for movable collateral route.

Output JSON:
```json
{ "success": true, "txHash": "0x...", "messageId": "0x..." }
```
