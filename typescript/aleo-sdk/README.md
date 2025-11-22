# Hyperlane Aleo SDK

The Hyperlane Aleo SDK is a fully typed TypeScript SDK for the [Aleo Implementation](https://github.com/hyperlane-xyz/hyperlane-aleo).
It can be used as a standalone SDK for frontend or in backend applications which want to connect to a Aleo chain which has the Hyperlane blueprint installed.

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/aleo-sdk

# Or with Yarn
yarn add @hyperlane-xyz/aleo-sdk
```

## Usage

```ts
import { AleoProvider, AleoSigner } from "@hyperlane-xyz/aleo-sdk";

const signer = await AleoSigner.connectWithSigner(
  ['http://localhost:3030'],
  PRIV_KEY,
  {
    metadata: {
      chainId: 1
    }
  }
);

const mailboxAddress = await signer.createMailbox({ domainId: 75898670 });

const mailbox = await signer.getMailbox({ mailboxAddress });
...

// performing queries without signer
const provider = await AleoProvider.connect(
  ['http://localhost:3030'],
  1
);

const mailbox = await provider.getMailbox({ mailboxAddress });
```

## Setup

Node 18 or newer is required.
