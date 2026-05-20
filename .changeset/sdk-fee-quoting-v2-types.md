---
"@hyperlane-xyz/sdk": minor
---

Added v2 fee-quoting API types alongside the legacy v1 (`/quote/*`) types. The v2 shape splits a request into quoter-specific endpoints (`/v2/quote/warp` and `/v2/quote/igp`), returns at most one quote per response, and is protocol-agnostic via a generic envelope:

- `QuoteV2Response` — `{ quote: AnyQuoteV2Entry }`
- `QuoteV2Entry<P extends ProtocolType, D>` — protocol-discriminated envelope generic over `(protocol, details)` so new VMs are added by introducing a `*QuoteV2Entry` alias.
- `EthereumQuoteV2Entry` — wraps `EthereumQuoteDetails` (existing EIP-712 `SignedQuoteData` + signature).
- `SealevelQuoteV2Entry` — wraps `SealevelQuoteDetails` (`domainId` + hex-encoded `SvmSignedQuote` fields).
- `AnyQuoteV2Entry` — discriminated union of the protocol variants.
- `NoQuoteAvailableReason` const + type — `not_authorized | not_upgraded | not_configured`, the 404 reasons the v2 endpoints return when a quoter can't be resolved.
- `NO_QUOTE_AVAILABLE_ERROR` constant for matching the 404 error code.

v1 types (`SubmitQuoteCommand`, `FeeQuotingQuoteResponse`, `SignedQuoteData`) are unchanged — v2 is purely additive.
