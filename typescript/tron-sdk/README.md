# Hyperlane TRON SDK

The Hyperlane TRON SDK is a fully typed TypeScript SDK for the [TRON Implementation](https://github.com/hyperlane-xyz/hyperlane-tron).
It can be used as a standalone SDK for frontend or in backend applications which want to connect to a TRON chain which has the Hyperlane blueprint installed.

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/tron-sdk

# Or with pnpm
pnpm add @hyperlane-xyz/tron-sdk
```

## Usage

```ts
import { TronProvider, TronSigner } from "@hyperlane-xyz/tron-sdk";
import { ChainMetadataForAltVM, ProtocolType } from "@hyperlane-xyz/provider-sdk";

const metadata: ChainMetadataForAltVM = {
  name: 'tron',
  protocol: ProtocolType.Tron,
  chainId: 1,
  domainId: 75898670,
  rpcUrls: [{ http: 'http://localhost:3030' }],
};

const signer = await TronSigner.connectWithSigner(metadata, PRIV_KEY);

const mailboxAddress = await signer.createMailbox({ domainId: 75898670 });

const mailbox = await signer.getMailbox({ mailboxAddress });
...

// performing queries without signer
const provider = await TronProvider.connect(metadata);

const mailbox = await provider.getMailbox({ mailboxAddress });
```

## Setup

Node 18 or newer is required.
