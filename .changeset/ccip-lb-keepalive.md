---
"@hyperlane-xyz/ccip-server": patch
---

The server keep-alive timeout was raised to 620s so idle connections outlive the GCE load balancer's 600s backend reuse window.
