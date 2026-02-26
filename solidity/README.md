# Hyperlane Core

Hyperlane Core contains the contracts and typechain artifacts for the Hyperlane implementation for EVM.

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/core

# Or with pnpm
pnpm add @hyperlane-xyz/core
```

Note, this package uses [ESM Modules](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c#pure-esm-package)

## Build

```bash
pnpm build
```

## Test

```bash
pnpm test
```

### Fixtures

Some forge tests may generate fixtures. This allows the [SDK](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/main/typescript/sdk) tests to leverage forge fuzzing. These are git ignored and should not be committed.

## Contributing

When modifying Solidity contracts, CI checks will validate that appropriate changesets are included based on the type of change:

| Analysis      | Change Type                              | Required Changeset |
| ------------- | ---------------------------------------- | ------------------ |
| **Bytecode**  | Any change                               | `patch` or higher  |
| **Interface** | Addition (new functions, events, errors) | `minor` or higher  |
| **Interface** | Removal or modification                  | `major`            |
| **Storage**   | Addition (new storage slots)             | `minor` or higher  |
| **Storage**   | Removal                                  | `major`            |

To add a changeset, run:

```bash
pnpm changeset
```

Select `@hyperlane-xyz/core` and choose the appropriate bump level based on your changes.

## License

Apache 2.0
