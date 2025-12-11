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

## Environment variables

A couple of env variables are used to influence the behaviour of the aleo-sdk.

- **ALEO_SKIP_PROOFS=true/false**: if set to true it will build transactions specifically for the aleo devnode skipping proof generation and making the execution much faster. This is very helpful for running e2e tests or for testnet deploys.
- **ALEO_SKIP_SUFFIXES=true/false**: if set to true it will deploy all contracts with the original program id. This is only needed for the first ever core deploy.
- **ALEO_UPGRADE_AUTHORITY=\<authority>**: if this is set the aleo-sdk will make all programs upgradable during the deploy step. For normal aleo wallets the value should simply be
  the aleo account address. For multisigs the format should be the following: "my_multisig.aleo/my_mapping/my_key"
- **ALEO_CONSENSUS_VERSION_HEIGHTS=0,1,2,3,4,5,6,7,8,9,10,11**: if this is set to an array of numbers it will be used to call the `getOrInitConsensusVersionTestHeights` needed for local networks
- **ALEO_ISM_MANAGER_SUFFIX=\<suffix>**: if this is set the suffix will be appended to the ism manager program (ism_manager\_{suffix}.aleo)
- **ALEO_WARP_SUFFIX=usdc**: if this is set the suffixes of warp programs will be set to this value, when omitted a random id is chosen

## Setup

Node 18 or newer is required.
