# Hyperlane

[![GitHub Actions][gha-badge]][gha] [![codecov](https://codecov.io/gh/hyperlane-xyz/hyperlane-monorepo/branch/main/graph/badge.svg?token=APC7C3Q2GS)](https://codecov.io/gh/hyperlane-xyz/hyperlane-monorepo) [![Foundry][foundry-badge]][foundry] [![License: MIT][license-badge]][license]

[gha]: https://github.com/hyperlane-xyz/hyperlane-monorepo/actions
[gha-badge]: https://github.com/PaulRBerg/prb-math/actions/workflows/ci.yml/badge.svg
[codecov-badge]: https://img.shields.io/codecov/c/github/hyperlane-xyz/hyperlane-monorepo
[foundry]: https://getfoundry.sh/
[foundry-badge]: https://img.shields.io/badge/Built%20with-Foundry-FFDB1C.svg
[license]: https://opensource.org/licenses/MIT
[license-badge]: https://img.shields.io/badge/License-MIT-blue.svg

## Versioning

Note this is the branch for Hyperlane v3.

V2 is on the main branch but is eventually being phased out.

V1 has since been deprecated in favor of V2, but if you are looking for code relating to the existing V1 deployments of the `testnet2` or `mainnet` environments, refer to the [v1](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/v1) branch.

## Overview

Hyperlane is an interchain messaging protocol that allows applications to communicate between blockchains.

Developers can use Hyperlane to share state between blockchains, allowing them to build interchain applications that live natively across multiple chains.

To read more about interchain applications, how the protocol works, and how to integrate with Hyperlane, please see the [documentation](https://docs.hyperlane.xyz).

## Working on Hyperlane

### Workspaces

This monorepo uses [Yarn Workspaces](https://yarnpkg.com/features/workspaces). Installing dependencies, building, testing, and running prettier for all packages can be done from the root directory of the repository.

- Installing dependencies

  ```bash
  yarn install
  ```

- Building

  ```bash
  yarn build
  ```

If you are using [VSCode](https://code.visualstudio.com/), you can launch the [multi-root workspace](https://code.visualstudio.com/docs/editor/multi-root-workspaces) with `code mono.code-workspace`, install the recommended workspace extensions, and use the editor settings.

### Rust

See [`rust/README.md`](rust/README.md)

### Publishing JS/TS Packages

Packages can be versioned and published all at once with commands from the root.

First, increment the version to the desired value:

```bash
# An example of a prerelease version
yarn version:prepare 1.1.0-beta0
# Or a release version
yarn version:prepare 1.1.0
```

Commit this preparation so that it is clear which commit the release is from.

Next, ensure packages are cleaned and rebuilt:

```bash
yarn clean && yarn build
```

Finally, publish the packages to NPM

```bash
# Note: If you have not yet logged in, first run yarn npm login
yarn publish:all --otp YOUR_OTP_HERE
# Or for a pre-release, include the tag
yarn publish:all --otp YOUR_OTP_HERE --tag beta
```

Tag the commit with the appropriate version, and then create a github release with a changelog against the previous version https://github.com/hyperlane-xyz/hyperlane-monorepo/releases/new

### Release Agents

- Tag the commit with the current date in the format `agents-yyyy-mm-dd`; e.g. `agents-2023-03-28`.
- [Create a Github Release](https://github.com/hyperlane-xyz/hyperlane-monorepo/releases/new) with a changelog against the previous version titled `Agents MMMM DD, YYYY`, e.g. `Agents March 28, 2023`.
- Include the agent docker image tag in the description of the release
- Create a summary of change highlights
- Create a "breaking changes" section with any changes required
- Deploy agents with the new image tag (if it makes sense to)
