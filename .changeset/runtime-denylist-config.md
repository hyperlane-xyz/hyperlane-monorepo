---
'@hyperlane-xyz/sdk': minor
---

The relayer agent config schema gained `runtimeDenylistUrl` and `runtimeDenylistPollIntervalSecs` for a denylist the relayer polls at runtime. Non-local file URLs were rejected during configuration validation.
