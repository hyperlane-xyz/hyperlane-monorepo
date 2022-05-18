# Changelog

## Unreleased

- [Strongly type InterchainGasCalculator](https://github.com/abacus-network/abacus-monorepo/pull/433): Adds type guards and uses chainNames instead of domain IDs in `InterchainGasCalculator`
- Renamed `MultiProvider`'s `getDomainConnection` to `getChainConnection`
- Renamed `MultiGeneric`'s `domainMap` to `chainMap`
- Rename the mapping from chain names to domain IDs from `domains` to `chainMetadata`

## 0.1.1

Initial Alpha Release of the SDK