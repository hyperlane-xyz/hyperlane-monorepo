# Kaspa

##

See Epic for more info

## Structure

```
├──  demo
│   ├──  multisig // self contained demo for most basic multisig + relayer kaspa TX flow
│   ├──  relayer // self contained demo for relayer (with/without HL/Hub parts)
│   └──  validator // self contained demo for validator (with/without HL/Hub parts)
├──  lib
│   ├──  core // shared by relayer and validator libs
│   ├──  relayer // not used by validator lib
│   └──  validator // not used by relayer lib
```

## HL integrations

Actual binaries should go in the appropriate HL directories and call our libs.

See https://github.com/dymensionxyz/hyperlane-monorepo/tree/main-dym/rust/main/agents, https://github.com/dymensionxyz/hyperlane-monorepo/tree/main-dym/rust/main/chains.
