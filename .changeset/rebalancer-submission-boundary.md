---
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/tron-sdk': minor
---

Added transaction submission observers and typed failures that retained known identities across delegated sends, ambiguous broadcast responses, and later failures.

Solana sends were limited to one signed identity per invocation. Automatic blockhash resubmission was disabled by default, and the deprecated `enableBlockhashResubmit: true` setting was rejected before signing; callers using that setting must remove it or set it to `false`. Unresolved sends retained their original signature rather than risking duplicate execution with a fresh blockhash.

Tron receipt waits gained per-call deadlines covering requests, retries, confirmation checks, and receipt construction. Timed-out HTTP requests were cancelled without changing other waits or shared transport settings.
