# Hyperlane Cosmos Module SDK

The Hyperlane Cosmos Module SDK is a fully typed TypeScript SDK for the [Cosmos Hyperlane Module Implementation](https://github.com/bcp-innovations/hyperlane-cosmos).
It can be used as a standalone SDK for frontend or in backend applications which want to connect to a Cosmos SDK chain which has the Hyperlane Module installed.

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/cosmos-sdk

# Or with Yarn
yarn add @hyperlane-xyz/cosmos-sdk
```

## Usage

```ts
import { HyperlaneModuleClient, SigningHyperlaneModuleClient } from "@hyperlane-xyz/cosmos-sdk";
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';

// using hyperlane queries without needing signers
const client = await HyperlaneModuleClient.connect(
  "https://rpc-endpoint:26657"
);

const mailboxes = await client.query.core.Mailboxes();
const bridgedSupply = await client.query.warp.BridgedSupply({ id: "token-id" });
...

// performing hyperlane transactions
const wallet = await DirectSecp256k1Wallet.fromKey(PRIV_KEY);

const signer = await SigningHyperlaneModuleClient.connectWithSigner(
  "https://rpc-endpoint:26657",
  wallet,
);

const { response: mailbox } = await signer.createMailbox({
  owner: '...',
  local_domain: '...',
  default_ism: '...',
  default_hook: '...',
  required_hook: '...',
});

const mailboxId = mailbox.id;

await signer.remoteTransfer({
  sender: '...',
  token_id: '...',
  destination_domain: '...',
  recipient: '...',
  amount: '...',
  ...
});

// sign and broadcast custom messages
await signer.signAndBroadcast(signer.getAccounts()[0], [txs...]);
```

## Setup

Node 18 or newer is required.

## Testing

We have a `cosmos-sdk-e2e` job in CI that first runs a local node and then runs a suite of end-to-end tests. The `hyperlane-cosmos-simapp` image is created ad-hoc by the `hypd-docker` workflow, intended to be triggered manually by a developer when a new hyperlane-cosmos release is made.

> Note: When updating the `cosmos-sdk` and `cosmos-types` package to a new `hyperlane-cosmos` version, it's important to release a new `hyperlane-cosmos-simapp` image and update the tag used in the `cosmos-sdk-e2e` job. This ensures that the end-to-end tests run against the correct version of the `hyperlane-cosmos` module.

## Contribute

First you need to install the dependencies by running `yarn install`.

### Building the project

You can build the project with `yarn build`, the build output can be found under `dist`.
