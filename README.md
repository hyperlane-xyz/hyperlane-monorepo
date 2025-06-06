# Hyperlane

[![GitHub Actions][gha-badge]][gha] [![codecov](https://codecov.io/gh/hyperlane-xyz/hyperlane-monorepo/branch/main/graph/badge.svg?token=APC7C3Q2GS)](https://codecov.io/gh/hyperlane-xyz/hyperlane-monorepo) [![Foundry][foundry-badge]][foundry] [![License: MIT][license-badge]][license]

[gha]: https://github.com/hyperlane-xyz/hyperlane-monorepo/actions
[gha-badge]: https://github.com/PaulRBerg/prb-math/actions/workflows/ci.yml/badge.svg
[codecov-badge]: https://img.shields.io/codecov/c/github/hyperlane-xyz/hyperlane-monorepo
[foundry]: https://getfoundry.sh/
[foundry-badge]: https://img.shields.io/badge/Built%20with-Foundry-FFDB1C.svg
[license]: https://www.apache.org/licenses/LICENSE-2.0
[license-badge]: https://img.shields.io/badge/License-Apache-blue.svg

## Versioning

Note this is the branch for Hyperlane v3.

V2 is deprecated in favor of V3. The code for V2 can be found in the [v2](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/v2) branch. For V1 code, refer to the [v1](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/v1) branch.

## Overview

Hyperlane is an interchain messaging protocol that allows applications to communicate between blockchains.

Developers can use Hyperlane to share state between blockchains, allowing them to build interchain applications that live natively across multiple chains.

To read more about interchain applications, how the protocol works, and how to integrate with Hyperlane, please see the [documentation](https://docs.hyperlane.xyz).

## Working on Hyperlane

### Prerequisites

#### Install `jq`

You need `jq` installed on your machine. You can download it from [official page](https://jqlang.github.io/jq/download/) or use a package manager of your choice.

#### Install `gitleaks`

You need `gitleaks` installed on your machine. You can download it from [official page](https://github.com/gitleaks/gitleaks) or use a package manager of your choice.

#### Foundry

First ensure you have Foundry installed on your machine.

Run the following to install `foundryup`:

```bash
curl -L https://foundry.paradigm.xyz | bash
```

Then run `foundryup` to install `forge`, `cast`, `anvil` and `chisel`.

```bash
foundryup
```

Check out the [Foundry Book](https://getfoundry.sh/getting-started/installation) for more information.

#### Node

This repository targets v20 of node. We recommend using [nvm](https://github.com/nvm-sh/nvm) to manage your node version.

To install nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
```

To install version 20

```bash
nvm install 20
nvm use 20
```

You should change versions automatically with the `.nvmrc` file.

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

### Logging

The typescript tooling uses [Pino](https://github.com/pinojs/pino) based logging, which outputs structured JSON logs by default.
The verbosity level and style can be configured with environment variables:

```sh
LOG_LEVEL=DEBUG|INFO|WARN|ERROR|OFF
LOG_FORMAT=PRETTY|JSON
```

### Rust

See [`rust/README.md`](rust/README.md)

### Release Agents

- Tag the commit with the current date in the format `agents-yyyy-mm-dd`; e.g. `agents-2023-03-28`.
- [Create a Github Release](https://github.com/hyperlane-xyz/hyperlane-monorepo/releases/new) with a changelog against the previous version titled `Agents MMMM DD, YYYY`, e.g. `Agents March 28, 2023`.
- Include the agent docker image tag in the description of the release
- Create a summary of change highlights
- Create a "breaking changes" section with any changes required
- Deploy agents with the new image tag (if it makes sense to)

### Releasing packages to NPM

We use [changesets](https://github.com/changesets/changesets) to release to NPM. You can use the `release` script in `package.json` to publish.

For an alpha or beta version, follow the directions [here](https://github.com/changesets/changesets/blob/main/docs/prereleases.md).

### Manually Triggering Docker Builds in CI

To manually trigger Agent or Monorepo Docker builds in CI, you can use the workflows provided in the repository. Here are the steps to do so:

1. **Navigate to the workflow:**

   - For agents, go to the [Rust Docker Workflow](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/workflows/rust-docker.yml).
   - For the monorepo, go to the [Monorepo Docker Workflow](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/workflows/monorepo-docker.yml).

2. **Trigger the workflow:**

   - On the workflow page, click on the "Run workflow" button.
   - You may need to select a branch and decide whether to trigger builds for the `arm64` platform.

3. **Wait for the build to complete:**
   - Once triggered, monitor the progress of the build by opening the new workflow run.
     - You may have to refresh the page for it to appear.
   - Check the logs for any errors or issues during the build process.
   - Wait for the `build-and-push-to-gcr` step to complete successfully before using the new image.
