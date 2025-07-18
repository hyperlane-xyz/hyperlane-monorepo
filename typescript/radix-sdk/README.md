# Hyperlane Radix SDK

The Hyperlane Radix SDK is a fully typed TypeScript SDK for the [Radix Implementation](https://github.com/hyperlane-xyz/hyperlane-radix).
It can be used as a standalone SDK for frontend or in backend applications which want to connect to a Radix chain which has the Hyperlane blueprint installed.

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/radix-sdk

# Or with Yarn
yarn add @hyperlane-xyz/radix-sdk
```

## Usage

```ts
import { RadixSDK, RadixSigningSDK } from "@hyperlane-xyz/radix-sdk";

const signingSdk = await RadixSigningSDK.fromPrivateKey(
  PRIV_KEY,
  {
    networkId: NetworkId.Stokenet,
  },
);

const mailboxAddress = await signingSdk.createMailbox(75898670);

const mailbox = await signingSdk.queryMailbox(mailboxAddress)
...

// performing queries without signer
const sdk = new RadixSDK({
  networkId: NetworkId.Stokenet,
})

const mailbox = await signingSdk.queryMailbox(mailboxAddress)
```

## Setup

Node 18 or newer is required.
