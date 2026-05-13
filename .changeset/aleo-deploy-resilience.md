---
'@hyperlane-xyz/aleo-sdk': patch
---

Aleo deployments were made resilient to transient explorer 5xx during program-import fetches inside snarkVM, and to the propagation lag between tx confirmation and /program/<id> readability.
