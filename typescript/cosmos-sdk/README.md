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
const lightClient = await HyperlaneModuleClient.connect(
  "https://rpc-endpoint:26657"
);

const mailboxes = await lightClient.query.core.Mailboxes();
const bridgedSupply = await lightClient.query.warp.BridgedSupply({ id: "token-id" });
...

// performing hyperlane transactions
const wallet = await DirectSecp256k1Wallet.fromKey(PRIV_KEY);

const signingClient = await SigningHyperlaneModuleClient.connectWithSigner(
  "https://rpc-endpoint:26657",
  wallet,
);

const txReceipt = await signingClient.createMailbox({
  owner: '...',
  local_domain: '...',
  default_ism: '...',
  default_hook: '...',
  required_hook: '...',
})

await signingClient.remoteTransfer({
  sender: '...',
  token_id: '...',
  destination_domain: '...',
  recipient: '...',
  amount: '...',
  ...
})

// sign and broadcast custom messages
await signingClient.signAndBroadcast(signer.getAccounts()[0], [txs...])
```

## Contribute

First you need to install the dependencies by running `yarn install`.

### Generating TS Types

You can automatically generate the TypeScript types from the proto files of the Cosmos Hyperlane Module by executing the following commands. Note that this only needs to be done if the proto files change in the Cosmos Hyperlane Module project.

```bash
cd proto
docker compose up
```

After this command has finished the newly generated types can be found under `src/types`.

### Building the project

You can build the project with `yarn build`, the build output can be found under `dist`.

## License

Apache 2.0
