# Kaspa

##

See Epic for more info

## Structure

```
├──  tooling // tooling for users, validator operators, developers etc
├──  lib
│   ├──  core // shared by relayer and validator libs
│   ├──  relayer // not used by validator lib
│   └──  validator // not used by relayer lib
```

## HL integrations

Actual binaries should go in the appropriate HL directories and call our libs.

See https://github.com/dymensionxyz/hyperlane-monorepo/tree/main-dym/rust/main/agents, https://github.com/dymensionxyz/hyperlane-monorepo/tree/main-dym/rust/main/chains.
