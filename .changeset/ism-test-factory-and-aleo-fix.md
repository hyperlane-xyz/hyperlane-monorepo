---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/utils': patch
---

ISM update test coverage was improved by creating a shared test factory that works across AltVM protocols (Cosmos, Aleo, Radix). The factory supports explicit test skipping configuration through a `skipTests` parameter, making protocol-specific limitations clear in test configuration rather than hidden in implementation.

Aleo address handling was fixed to properly support ISM unsetting. The `isZeroishAddress` regex now matches Aleo null addresses both with and without program ID prefix. The `fromAleoAddress` helper was updated to handle addresses without the '/' separator. The `getSetTokenIsmTransaction` method now converts zero addresses to `ALEO_NULL_ADDRESS` before processing.
