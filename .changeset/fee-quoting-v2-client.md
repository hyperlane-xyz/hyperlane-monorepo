---
"@hyperlane-xyz/sdk": minor
---

A `FeeQuotingV2Client` was added alongside the existing `FeeQuotingClient`, targeting the v2 fee-quoting API's `GET /v2/quote/warp` and `GET /v2/quote/igp` endpoints. Successful responses were decoded into an `AnyQuoteV2Entry`; 404 responses carrying the `no_quote_available` body were surfaced as a typed `FeeQuotingNoQuoteAvailableError` (with `reason` + `detail` fields) so consumers can branch on the cause without re-parsing the response. The SDK also gained `decodeSealevelQuoteEntry`, which converts the hex byte fields on a `SealevelQuoteV2Entry` into a `DecodedSealevelQuoteEntry` whose `signedQuote.*` fields are `Uint8Array` — structurally identical to what svm-sdk's submit-quote helpers consume, so the boundary can be duck-typed without the main SDK depending on `@hyperlane-xyz/sealevel-sdk`. Two new shared constants (`QUOTE_V2_BASE_PATH`, `QuoteV2Endpoint`) document the v2 URL contract.
