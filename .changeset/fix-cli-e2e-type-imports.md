---
"@hyperlane-xyz/cli": patch
---

Fixed CLI e2e tests failing locally by properly marking type imports with the `type` keyword. This ensures compatibility with tsx which reads JS files directly, while tests in CI continue to work with the bundled CLI.
