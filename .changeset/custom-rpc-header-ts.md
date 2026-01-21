---
'@hyperlane-xyz/sdk': minor
---

Added `custom_rpc_header` query parameter support to SmartProvider, matching Rust agent behavior from PR #5379. This enables reusing the same authenticated RPC URLs across both TypeScript and Rust tooling.
