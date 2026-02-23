# global-netting

Purpose: produce rebalancing action plan from current+historical context.

Input:
- `provider`
- `model`
- merged context:
  - observation
  - inflight
  - prior SQL context (open intents/actions, reconciliations, transcripts)

Requirements:
- Return strict JSON only.
- Prefer netting opposing imbalances across monitored routes before external bridge actions.
- Respect configured `executionPaths`.
- Include action fingerprints.

Output JSON:
```json
{
  "summary": "...",
  "actions": [
    {
      "actionFingerprint": "route|origin|destination|srcRouter|dstRouter|amount|executionType|epoch",
      "executionType": "inventory",
      "routeId": "MULTI/stableswap",
      "origin": "anvil2",
      "destination": "anvil3",
      "sourceRouter": "0x...",
      "destinationRouter": "0x...",
      "amount": "1000000",
      "bridge": "lifi",
      "reason": "deficit reduction"
    }
  ]
}
```
