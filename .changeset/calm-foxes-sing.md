---
'@hyperlane-xyz/sdk': patch
---

Replaced z.coerce.bigint().positive() with ZBigNumberish.refine() in TokenMetadataSchema scale field for zod-to-json-schema compatibility. Fixed validateZodResult generic to correctly return output type for schemas with transforms.
