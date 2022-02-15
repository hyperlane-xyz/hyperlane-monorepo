## Abacus Provider

Abacus Provider is a management system for
[ethers.js](https://docs.ethers.io/v5/) providers and signers that helps
developers connect to multiple networks simultaneously. It is part
of the [Abacus](https://github.com/celo-org/optics-monorepo) project, but may
be useful to other multi-chain systems.

This package includes the `MultiProvider`, as well as an `AbacusContext` for
interacting with deployed Abacus systems. The dev, staging, and mainnet Abacus
systems have pre-built objects for quick development.

### Intended Usage

```ts
import * as ethers from 'ethers';

import { mainnet } from '@abacus-network/sdk';

// Set up providers and signers
const someEthersProvider = ethers.providers.WsProvider('...');
const someEthersSigner = new AnySigner(...);
mainnet.registerProvider('ethereum', someEthersProvider);
mainnet.registerSigner('ethereum', someEthersSigner);

// We have shortcuts for common provider/signer types
mainnet.registerRpcProvider('celo', 'https://forno.celo.org');
mainnet.registerWalletSigner('celo', '0xabcd...');

// Interact with the Abacus Bridge
// Send ETH from ethereum to celo
await mainnet.sendNative(
    'ethereum', // source
    'celo',  // destination
    ethers.constants.WeiPerEther, // amount
    '0x1234...',  // recipient
);

// Send Tokens from celo to ethereum
await mainnet.send(
    'celo',  // source
    'ethereum', // destination
    { domain: 'ethereum', id: "0xabcd..."} // token information
    ethers.constants.WeiPerEther, // amount
    '0x1234...'  // recipient
    { gasLimit: 300_000 } // standard ethers tx overrides
);

// so easy.
```
