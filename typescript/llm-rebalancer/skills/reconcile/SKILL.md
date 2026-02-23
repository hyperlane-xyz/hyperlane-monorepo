# reconcile

Purpose: reconcile submitted actions against chain/explorer state and return delivery updates.

Input:
- planner output
- latest observation
- latest inflight messages

Output JSON:
```json
{
  "deliveredActionFingerprints": ["fp-1", "fp-2"],
  "notes": "..."
}
```
