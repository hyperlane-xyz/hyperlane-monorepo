---
'@hyperlane-xyz/sdk': patch
---

Replaced z.coerce.bigint().positive() with pipe-based coercion in TokenMetadataSchema scale field to fix zod-to-json-schema compatibility in the registry build.
