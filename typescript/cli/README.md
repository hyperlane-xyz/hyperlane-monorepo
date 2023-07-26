# Hyperlane CLI

The Hyperlane CLI is a command-line tool written in Typescript that facilitates common operations on Hyperlane, such as deploying the core contracts and/or warp routes to new chains.

## Hyperlane overview

Hyperlane is an interchain messaging protocol that allows applications to communicate between blockchains.

Developers can use Hyperlane to share state between blockchains, allowing them to build interchain applications that live natively across multiple chains.

To read more about interchain applications, how the protocol works, and how to integrate with Hyperlane, please see the [documentation](https://docs.hyperlane.xyz).

## Setup

Node 16 or newer is required.

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
node ./dist/cli.js
```

## Deploying Hyperlane

See below for instructions on using the scripts in this repo to deploy a Hyperlane core instance. For more details see the [deploy documentation](https://docs.hyperlane.xyz/docs/deploy/deploy-hyperlane).

### Deploying core contracts

If you're deploying to a new chain, ensure there is a corresponding entry `config/chains.ts`, `config/multisig_ism.ts`, and `config/start_blocks.ts`.

This script is used to deploy the following core Hyperlane contracts to a new chain. The Hyperlane protocol expects exactly one instance of these contracts on every supported chain.

- `Mailbox`: for sending and receiving messages
- `ValidatorAnnounce`: for registering validators

This script also deploys the following contracts to all chains, new and existing. The Hyperlane protocol supports many instances of these contracts on every supported chains.

- `ISM (e.g. MultisigISM)`: for verifying inbound messages from remote chains
- `InterchainGasPaymaster`: for paying relayers for message delivery
- `TestRecipient`: used to test that interchain messages can be delivered

```bash
yarn ts-node scripts/deploy-hyperlane.ts --local anvil \
  --remotes goerli sepolia \
  --key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### Sending test messages

This script is used to verify that Hyperlane messages can be sent between specified chains.

Users should have first deployed `TestRecipient` contracts to each of the specified chains.

```sh
yarn ts-node scripts/test-messages.ts \
  --chains anvil goerli sepolia \
  --key 0x6f0311f4a0722954c46050bb9f088c4890999e16b64ad02784d24b5fd6d09061
```

## Deploying Warp Routes

Warp Routes are Hyperlane's unique take on the concept of token bridging, allowing you to permissionlessly bridge any ERC20-like asset to any chain. You can combine Warp Routes with a Hyperlane deployment to create economic trade routes between any chains already connected through Hyperlane.

See below for instructions on using the scripts in this repo to deploy Hyperlane Warp Routes. For more details see the [warp route documentation](https://docs.hyperlane.xyz/docs/deploy/deploy-warp-route).

### Deploying Warp contracts

Establishing a warp route requires deployment of `HypERC20` contracts to the desired chains. Ensure there is an entry for all chains in `config/chains.ts`.

The deployment also require details about the existing (collateral) token and the new synthetics that will be created. Ensure there are entries for them in `config/warp_tokens.ts`.

```sh
yarn ts-node scripts/deploy-warp-routes.ts \
  --key 0x6f0311f4a0722954c46050bb9f088c4890999e16b64ad02784d24b5fd6d09061
```

### Sending a test transfer

```sh
yarn ts-node scripts/test-warp-transfer.ts \
  --origin goerli --destination alfajores --wei 100000000000000 \
  --key 0x6f0311f4a0722954c46050bb9f088c4890999e16b64ad02784d24b5fd6d09061
```

### Deploying a Warp UI

If you'd like to create a web-based user interface for your warp routes, see the [Warp UI documentation](https://docs.hyperlane.xyz/docs/deploy/deploy-warp-route/deploy-the-ui-for-your-warp-route)
