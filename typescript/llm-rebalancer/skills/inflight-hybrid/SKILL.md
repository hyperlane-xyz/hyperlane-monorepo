# inflight-hybrid

Purpose: merge RPC and Explorer inflight state.

Rules:
- Prefer freshest confirmed source for identical `messageId`.
- Keep both user and self actions.
- Output deduplicated list.

Output JSON:
```json
{ "messages": [] }
```
