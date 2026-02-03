---
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/widgets': patch
'@hyperlane-xyz/cli': patch
---

Added forward-compatible enum validation to prevent SDK failures when the registry contains new enum values. Added `Unknown` variants to `ProtocolType`, `TokenType`, `IsmType`, `HookType`, `ExplorerFamily`, and `ChainTechnicalStack` enums. Exported `KnownProtocolType` and `DeployableTokenType` for type-safe mappings.
