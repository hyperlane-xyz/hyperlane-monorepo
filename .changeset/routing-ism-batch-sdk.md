---
'@hyperlane-xyz/sdk': minor
---

Wired `HyperlaneIsmFactory` to use chunked routing ISM `setIsms` and `removeIsms` transactions for contracts at version 12.0.0 or newer, while preserving per-domain calls for older deployments. Atomic fallback routing ISM deployments were initialized with one chunk before enrolling the remainder and transferring ownership, limiting constructor gas without reopening the initialization race.
