---
"@hyperlane-xyz/sdk": patch
---

EvmHookReader now determines whether an IGP is legacy from its on-chain `PACKAGE_VERSION` (via the shared `fetchPackageVersion` helper) instead of probing `quoteSigners()` and classifying the revert. A legacy IGP whose empty-data revert is wrapped by the `HyperlaneSmartProvider` ("All providers failed" / "Invalid response from provider", never a `CALL_EXCEPTION`) is now correctly classified as legacy rather than causing a fatal hook-derivation error. `quoteSigners()` is only called once the version gate confirms a v2+ IGP.
