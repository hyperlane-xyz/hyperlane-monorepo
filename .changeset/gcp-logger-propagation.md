---
'@hyperlane-xyz/utils': patch
---

Fixed GCP logging configuration not being applied to SDK components like SmartProvider. When createServiceLogger initializes a GCP logger, it now also updates rootLogger so child loggers inherit the GCP config.
