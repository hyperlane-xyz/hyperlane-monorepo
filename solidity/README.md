# Hyperlane Core

Hyperlane Core contains the contracts and typechain artifacts for the Hyperlane implementation for EVM.

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/core

# Or with Yarn
yarn add @hyperlane-xyz/core
```

Note, this package uses [ESM Modules](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c#pure-esm-package)

## Build

```bash
yarn build
```

## Test

```bash
yarn test
```

### Fixtures

Some forge tests may generate fixtures. This allows the [SDK](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/main/typescript/sdk) tests to leverage forge fuzzing. These are git ignored and should not be committed.

## License

Apache 2.0
