---
"@hyperlane-xyz/sdk": minor
---

PostCallsSchema is now a backwards-compatible union accepting either `destinationDomain` + `owner` (new ICA derivation path) or `commitmentDispatchTx` (legacy dispatch tx path). Added `isPostCallsIca()` type guard, `PostCallsIcaType`, `PostCallsLegacyType` exports, and `commitmentFromRevealMessage()` helper. Tightened schema validation to use ZHash for `owner`, `salt`, `ismOverride`, and `commitmentDispatchTx` fields.
