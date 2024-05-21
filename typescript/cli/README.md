# Hyperlane CLI

The Hyperlane CLI is a command-line tool written in Typescript that facilitates common operations on Hyperlane, such as deploying the core contracts and/or warp routes to new chains.

## Hyperlane overview

Hyperlane is an interchain messaging protocol that allows applications to communicate between blockchains.

Developers can use Hyperlane to share state between blockchains, allowing them to build interchain applications that live natively across multiple chains.

To read more about interchain applications, how the protocol works, and how to integrate with Hyperlane, please see the [documentation](https://docs.hyperlane.xyz).

## Setup

Node 18 or newer is required.

**Option 1: Global install:**

```bash
# Install with NPM
npm install -g @hyperlane-xyz/cli
# Or uninstall old versions
npm uninstall -g @hyperlane-xyz/cli
```

**Option 2: Temp install:**

```bash
# Run via NPM's npx command
npx @hyperlane-xyz/cli
# Or via Yarn's dlx command
yarn dlx @hyperlane-xyz/cli
```

**Option 3: Run from source:**

```bash
git clone https://github.com/hyperlane-xyz/hyperlane-monorepo.git
cd hyperlane-monorepo
yarn install && yarn build
cd typescript/cli
yarn hyperlane
```

## Common commands

View help: `hyperlane --help`

Create a core deployment config: `hyperlane config create`

Run hyperlane core deployments: `hyperlane deploy core`

Run warp route deployments: `hyperlane deploy warp`

View SDK contract addresses: `hyperlane chains addresses`

Send test message: `hyperlane send message`

## Logging

The logging format can be toggled between human-readable vs JSON-structured logs using the `LOG_FORMAT` environment variable or the `--log <pretty|json>` flag.
The logging verbosity can be configured using the `LOG_LEVEL` environment variable or the `--verbosity <debug|info|warn|error|off>` flag.
