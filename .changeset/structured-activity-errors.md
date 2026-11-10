---
'@hyperlane-xyz/utils': patch
'@hyperlane-xyz/scraper-proxy': patch
'@hyperlane-xyz/ccip-server': patch
---

Added structured diagnostic errors to relayer failure, retry, ISM, and offchain-read progress, with matching GraphQL and WebSocket fields. Preserved Circle attestation delay reasons and gateway failures so consumers can explain delivery blockers without parsing log strings.
