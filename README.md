# Hyperlane

## Versioning

Note this is the branch for Hyperlane v2.

V1 has since been deprecated in favor of V2, but if you are looking for code relating to the existing V1 deployments of the `testnet2` or `mainnet` environments, refer to the [v1](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/v1) branch.

## Overview

Hyperlane is an interchain messaging protocol that allows applications to communicate between blockchains.

Developers can use Hyperlane to share state between blockchains, allowing them to build interchain applications that live natively across multiple chains.

To read more about interchain applications, how the protocol works, and how to integrate with Hyperlane, please see the [documentation](https://docs.hyperlane.xyz/).

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

- install [`rustup`](https://rustup.rs)
- see `rust/README.md`

### Running Agents Locally

See [this guide](rust/running-locally.md) for how to run the agents locally and perform a full end-to-end test.

#### Building Agent Images

There exists a docker build for the agent binaries. These docker images are used for deploying the agents in a production environment.

```bash
cd rust
./build.sh <image_tag>
./release.sh <image_tag>
```

#### Deploy Procedure

The contract addresses of each deploy can be found in `rust/config`. The latest
deploy will be at `rust/config/[latest timestamp]` with bridge contracts within
that same folder under `/bridge/[latest timestamp]`.

The agents are set up to point at one environment at a time.

When agents are deployed to point at a new environment, they cease to point at
the old ones. We **do not** continue to operate off-chain agents on old contract
deploys. Contracts not supported by the agents will cease to function (i.e.
messages will not be relayed between chains).

Off-chain agents are **not** automatically re-deployed when new contract deploys
are merged. Auto-redeploys will be implemented at some future date.

### Publishing Packages

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

For the git submodules, you will have to undo the removal of the `yarn.lock` files, `yarn install` and check in the yarn.lock changes on the submodule as well. Then checkin the updated commits on the monorepo itself.

Make PRs for the monorepo and the submodules.

Make a Github release

IGPS suck
