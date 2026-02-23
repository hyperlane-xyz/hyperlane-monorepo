# execute-inventory-lifi

Purpose: execute a single `inventory` action using LiFi + deposit path.

Input:
```json
{ "action": { "executionType": "inventory", "routeId": "...", "origin": "...", "destination": "...", "sourceRouter": "0x...", "destinationRouter": "0x...", "amount": "1000000", "bridge": "lifi", "actionFingerprint": "..." } }
```

Expected execution:
- If destination inventory insufficient, move inventory via LiFi.
- Execute router deposit path (`transferRemote`/`transferRemoteTo` as needed).

Output JSON:
```json
{ "success": true, "txHash": "0x...", "messageId": "0x..." }
```
