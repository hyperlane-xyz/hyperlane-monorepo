---
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/widgets": minor
---

Added ERC-2612 permit support for gasless token approvals. The SDK now includes permit types, adapter methods for checking permit support and signing permit data, and WarpCore integration that accepts permit signatures as an alternative to traditional approval transactions. The widgets package exports a new `useSignPermit` hook for signing EIP-712 typed permit messages with wagmi.
