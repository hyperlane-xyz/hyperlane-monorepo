---
"@hyperlane-xyz/sdk": patch
---

Added timeout protection to MultiProvider.handleTx() for numeric block confirmation waits. The existing timeoutMs option now applies to both numeric and block-tag confirmation paths, with a default of 5 minutes. This prevents indefinite hangs when ethers.js response.wait() fails to resolve.