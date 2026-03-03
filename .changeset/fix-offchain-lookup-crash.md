---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/ccip-server': patch
---

The PostCallsSchema was tightened to validate `to` and `relayers` fields with ZHash regex, rejecting malicious input (empty strings, URLs, injection payloads) at parse time. A try/catch was added around `normalizeCalls` in `CallCommitmentsService` as defense-in-depth to return 400 instead of crashing the pod.
