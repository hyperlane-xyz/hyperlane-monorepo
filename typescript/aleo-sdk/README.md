# Hyperlane Aleo SDK

The Hyperlane Aleo SDK is a fully typed TypeScript SDK for the [Aleo Implementation](https://github.com/hyperlane-xyz/hyperlane-aleo).
It can be used as a standalone SDK for frontend or in backend applications which want to connect to a Aleo chain which has the Hyperlane blueprint installed.

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/aleo-sdk

# Or with pnpm
pnpm add @hyperlane-xyz/aleo-sdk
```

## Usage

```ts
import { AleoProvider, AleoSigner } from "@hyperlane-xyz/aleo-sdk";
import { ChainMetadataForAltVM, ProtocolType } from "@hyperlane-xyz/provider-sdk";

const metadata: ChainMetadataForAltVM = {
  name: 'aleo',
  protocol: ProtocolType.Aleo,
  chainId: 1,
  domainId: 75898670,
  rpcUrls: [{ http: 'http://localhost:3030' }],
};

const signer = await AleoSigner.connectWithSigner(metadata, PRIV_KEY);

const mailboxAddress = await signer.createMailbox({ domainId: 75898670 });

const mailbox = await signer.getMailbox({ mailboxAddress });
...

// performing queries without signer
const provider = await AleoProvider.connect(metadata);

const mailbox = await provider.getMailbox({ mailboxAddress });
```

## Environment variables

A couple of env variables are used to influence the behaviour of the aleo-sdk.

- **ALEO_SKIP_PROOFS=true/false**: if set to true it will build transactions specifically for the aleo devnode skipping proof generation and making the execution much faster. This is very helpful for running e2e tests or for testnet deploys.
- **ALEO_SKIP_SUFFIXES=true/false**: if set to true it will deploy all contracts with the original program id. This is only needed for the first ever core deploy.
- **ALEO_UPGRADE_AUTHORITY=\<authority>**: if this is set the aleo-sdk will make all programs upgradable during the deploy step. For normal aleo wallets the value should simply be
  the aleo account address. For multisigs the program id of the multisig should be the value, example: `ALEO_UPGRADE_AUTHORITY=hyp_multisig_core.aleo`.
- **ALEO_CONSENSUS_VERSION_HEIGHTS=0,1,2,3,4,5,6,7,8,9,10,11**: if this is set to an array of numbers it will be used to call the `getOrInitConsensusVersionTestHeights` needed for local networks
- **ALEO_ISM_MANAGER_SUFFIX=\<suffix>**: if this is set the suffix will be appended to the ism manager program (ism_manager\_{suffix}.aleo)
- **ALEO_WARP_SUFFIX=usdc**: if this is set the suffixes of warp programs will be set to this value, when omitted a random id is chosen

## Setup

Node 22 or newer is required.

## Deploying v3 ARC-22 warp routes

Use the existing synthetic deployment flow with a compiled program override:

```bash
export ALEO_HYP_SYNTHETIC=/absolute/path/to/hyp_warp_token_usdt_v3.aleo
hyperlane warp deploy --warp-route-id USDT/aleo-ethereum
```

Use your registered warp route ID in place of the example.

The file must be compiled Aleo instructions, not Leo source. Compile with the Leo
version specified by the route's `program.json` (USDT v3 specifies 4.4.4). The
synthetic deploy config supplies `name`, `symbol`, `decimals`, and optional `scale`;
`scale` determines the remote decimals relative to the local decimals.

The override is deployed verbatim: program IDs, imports, and the constructor are
preserved. `ALEO_WARP_SUFFIX` and `ALEO_UPGRADE_AUTHORITY` do not rewrite an override.
Setting a v3 suffix without an override still deploys the bundled template.

All imported programs must already be deployed on the selected network, including
the ARC-22 token, freeze list, Hyperlane core, and any imported previous route.
Configure the token's mint/burn permissions for the new route separately. The
warp deployment initializes the route and configures its routers, ISM, and hook;
it does not deploy or administer the ARC-22 token or freeze list.

V2 and v3 route reads resolve token metadata, public balances, and supply from the
imported ARC-20/ARC-22 program. Bridging uses the existing public mint/burn flow.
