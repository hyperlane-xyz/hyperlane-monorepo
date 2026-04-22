---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/infra': patch
'@hyperlane-xyz/relayer': patch
'@hyperlane-xyz/sdk': patch
---

Import cycles flagged by oxlint were resolved by extracting shared code into dedicated leaf modules, performing a hard cutover (no backcompat re-exports), and using dependency injection for submitter factories and aggregation metadata decoding. The `import/no-cycle` lint rule is now enforced as an error.
