---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/infra': patch
'@hyperlane-xyz/relayer': patch
'@hyperlane-xyz/sdk': patch
---

Fixed import cycles by extracting shared code into separate modules, removing unnecessary re-exports, and using dependency injection for submitter factories.
