---
"@hyperlane-xyz/core": minor
---

`OffchainQuotedLinearFee` exposed its standing-quote mapping for offchain enumeration. The `quotes` keys are now tracked in enumerable sets as standing quotes are stored, and two views were added: `quoteDomains()` returns the domain ids with at least one standing quote, and `getQuotesForDomain(domainId)` returns every quote stored under that exact domain key as `QuoteEntry[]` (recipient plus the `StoredQuote`). Entries are never removed, so enumeration includes the wildcard recipient and logically-expired quotes; recipient-only quotes are stored under the `WILDCARD_DEST` key and apply to every destination, so callers computing effective fees also query that key.
