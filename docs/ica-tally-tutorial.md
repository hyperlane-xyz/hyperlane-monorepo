# Hyperlane ICA + Tally DAO Integration Tutorial

## Cross-Chain Asset Management with Interchain Accounts

This tutorial walks through using Hyperlane's **Interchain Accounts (ICAs)** to enable a Tally DAO to manage assets across multiple chains. By the end, you'll know how to get your DAO's ICA address, fund it on a remote chain, and create a governance proposal to move those assets.

---

## Prerequisites

- Node.js 18+ and pnpm installed
- A Tally DAO deployed on a supported chain (e.g., Ethereum, Optimism, Arbitrum)
- Access to the DAO's governance contract address
- A wallet with funds on both the origin and destination chains
- Basic familiarity with Ethereum, Solidity, and TypeScript

### Setup

```bash
git clone https://github.com/hyperlane-xyz/hyperlane-monorepo.git
cd hyperlane-monorepo
pnpm install
cd typescript/cli
```

Create a \.env\ file with your RPC URLs and private key:

```env
HYP_KEY=<your-private-key>
HYP_RPC_URL_ETHEREUM=https://eth.llamarpc.com
HYP_RPC_URL_OPTIMISM=https://optimism.llamarpc.com
```

---

## Background: How Hyperlane ICAs Work

Hyperlane's Interchain Accounts allow an **owner address** on an **origin chain** to control a smart contract account on a **remote chain**. The ICA is deployed via CREATE2, meaning its address is deterministic and can be computed before deployment.

Key contracts:
- **InterchainAccountRouter** — deployed on each chain; handles cross-chain message dispatch and ICA deployment
- **ICA Proxy** — the actual account contract on the remote chain; executes calls forwarded through Hyperlane

The workflow is:
1. The owner calls `callRemote()` on the origin chain's router
2. Hyperlane relays the message to the destination chain
3. The destination router delivers the calls to the ICA proxy
4. The ICA proxy executes the calls as if the owner made them directly

---

## Step 1: Get the ICA Address for Your DAO

The ICA address is deterministic based on the **owner address**, **origin domain**, and an optional **salt**. For a Tally DAO, the owner is typically the DAO's **Governor** or **Timelock** contract.

### Using the Hyperlane CLI

```bash
# First, check if the ICA is already deployed
cd typescript/cli
pnpm hyperlane ica deploy \\
  --origin ethereum \\
  --chains optimism \\
  --owner <YOUR_DAO_GOVERNOR_ADDRESS>
```

The CLI will output:
- Whether an ICA already exists (showing the address)
- Or deploy a new one (showing the deployed address)

### Using the SDK Programmatically

```typescript
import { InterchainAccount } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';

async function getDaoIcaAddress() {
  const multiProvider = new MultiProvider({
    ethereum: { rpcUrl: process.env.HYP_RPC_URL_ETHEREUM },
    optimism:  { rpcUrl: process.env.HYP_RPC_URL_OPTIMISM },
  });

  // Chain addresses from Hyperlane registry
  const addressesMap = {
    ethereum: { interchainAccountRouter: '0x...' },
    optimism:  { interchainAccountRouter: '0x...' },
  };

  const ica = InterchainAccount.fromAddressesMap(addressesMap, multiProvider);

  const daoOwnerAddress = '0xYOUR_DAO_GOVERNOR_ADDRESS';

  // Get the deterministic ICA address on Optimism
  const icaAddress = await ica.getAccount('optimism', {
    origin: 'ethereum',
    owner: daoOwnerAddress,
  });

  console.log('DAO ICA on Optimism:', icaAddress);
  return icaAddress;
}
```

The `getAccount()` method returns the deterministic address **without** deploying the account. Use `deployAccount()` to actually deploy it if needed.

---

## Step 2: Send Funds to the DAO's ICA on a Remote Chain

Once you have the ICA address, sending funds is a standard EVM transfer. You can do this from any wallet (MetaMask, a script, or another contract).

### Via MetaMask / Wallet

1. Copy the ICA address obtained in Step 1
2. Switch your wallet to the destination chain (e.g., Optimism)
3. Send ETH (or any ERC-20 token) to the ICA address
4. The ICA now holds those funds and can execute transactions with them

### Via Script (using ethers.js)

```typescript
import { ethers } from 'ethers';

async function fundIca(icaAddress: string, amountEth: string) {
  const provider = new ethers.JsonRpcProvider(process.env.HYP_RPC_URL_OPTIMISM);
  const wallet = new ethers.Wallet(process.env.HYP_KEY!, provider);

  const tx = await wallet.sendTransaction({
    to: icaAddress,
    value: ethers.parseEther(amountEth),
  });

  await tx.wait();
  console.log('Sent', amountEth, 'ETH to ICA:', icaAddress);
  console.log('Tx hash:', tx.hash);
}

// Send 0.1 ETH to the DAO's ICA
await fundIca('0x_ICA_ADDRESS_FROM_STEP_1', '0.1');
```

### For ERC-20 Tokens

```typescript
const erc20Abi = ['function transfer(address to, uint256 amount) returns (bool)'];

async function fundIcaWithToken(
  icaAddress: string,
  tokenAddress: string,
  amount: string
) {
  const provider = new ethers.JsonRpcProvider(process.env.HYP_RPC_URL_OPTIMISM);
  const wallet = new ethers.Wallet(process.env.HYP_KEY!, provider);
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);

  const tx = await token.transfer(icaAddress, ethers.parseUnits(amount, 6));
  await tx.wait();
  console.log('Sent', amount, 'USDC to ICA via tx:', tx.hash);
}
```

---

## Step 3: Create a Tally Proposal to Use ICA Funds

Now that the ICA holds funds on the remote chain, the DAO needs to pass a governance proposal to move them. This is done by creating a proposal that calls `callRemote()` on the origin chain's **InterchainAccountRouter**.

### Understanding \callRemote\

The `callRemote()` function on \InterchainAccountRouter\ takes:
- \_destinationDomain\ — the domain ID of the remote chain
- \_router\ — the remote chain's ICA router address (bytes32)
- \_ism\ — the Interchain Security Module to use
- \_calls\ — array of calls to execute on the remote chain

Each call in \_calls\ has:
- \	o\ — target address on the remote chain
- \alue\ — ETH value to send
- \data\ — calldata to execute

### Option A: Using the Hyperlane SDK

```typescript
import { InterchainAccount } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';
import { ethers } from 'ethers';

async function createIcaCallsForProposal() {
  // Build ICA app instance (same as Step 1)
  const ica = /* ... from Step 1 ... */;

  // Define the calls you want the ICA to execute on the remote chain
  const innerCalls = [
    {
      to: addressToBytes32('0x_RECIPIENT_ON_OPTIMISM'),
      value: ethers.parseEther('0.05'),
      data: '0x', // plain ETH transfer
    },
    {
      to: addressToBytes32('0x_USDC_TOKEN_ON_OPTIMISM'),
      value: 0,
      data: new ethers.Interface([
        'function transfer(address to, uint256 amount)'
      ]).encodeFunctionData('transfer', [
        '0x_RECIPIENT_ADDRESS',
        ethers.parseUnits('100', 6),
      ]),
    },
  ];

  // Get the populated transaction for callRemote
  // This is what the DAO proposal will execute
  const tx = await ica.getCallRemote({
    chain: 'ethereum',            // origin chain (where the DAO is)
    destination: 'optimism',       // remote chain (where the ICA is)
    innerCalls,
    config: {
      origin: 'ethereum',
      owner: '0x_DAO_GOVERNOR_ADDRESS',
    },
  });

  console.log('Target contract:', tx.to);
  console.log('Calldata:', tx.data);
  console.log('Value (for IGP payment):', ethers.formatEther(tx.value || 0), 'ETH');

  return tx;
}
```

### Option B: Direct Contract Interaction

```typescript
import { ethers } from 'ethers';

const icaRouterAbi = [
  'function callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes) payable'
];

const router = new ethers.Contract(
  '0x_ICA_ROUTER_ON_ORIGIN_CHAIN',
  icaRouterAbi,
  signer
);

const tx = await router.callRemoteWithOverrides(
  destinationDomain,
  remoteRouter,
  ismAddress,
  calls,
  hookMetadata,
  { value: quote }
);
```

> **Note:** The recommended approach is Option A (SDK), as it handles encoding and fee quoting automatically.

### Creating the Tally Proposal

With the calldata from above, create a proposal on [Tally](https://www.tally.xyz/):

1. Go to your DAO's page on Tally
2. Click **Create Proposal**
3. Add a **Custom Transaction** action
4. Set the target address to the **InterchainAccountRouter** on the origin chain
5. Paste the calldata generated above
6. Set the ETH value to cover the IGP fee (from the \getCallRemote\ output)
7. Write a clear title and description
8. Submit for voting

```solidity
// The proposal's on-chain action is equivalent to:
// InterchainAccountRouter.callRemote(
//   destinationDomain,
//   remoteRouter,
//   ism,
//   calls,
//   hookMetadata
// )
```

Once the proposal passes and is executed:
1. The ICA router on Ethereum dispatches a message via Hyperlane
2. Relayers pick up the message and deliver it to Optimism
3. The ICA router on Optimism forwards the calls to the DAO's ICA proxy
4. The ICA proxy executes the calls (sending ETH/USDC to recipients)

---

## Full End-to-End Example

Here's a complete script that ties everything together:

```typescript
// scripts/ica-tally-demo.ts
import { InterchainAccount } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';
import { ethers } from 'ethers';

async function main() {
  // ===== Configuration =====
  const ORIGIN_CHAIN = 'ethereum';
  const DESTINATION_CHAIN = 'optimism';
  const DAO_GOVERNOR = '0x_YOUR_DAO_GOVERNOR_ADDRESS';
  const RECIPIENT = '0x_RECIPIENT_ADDRESS';

  // ===== Setup MultiProvider =====
  const multiProvider = new MultiProvider({
    ethereum: { rpcUrl: process.env.HYP_RPC_URL_ETHEREUM! },
    optimism:  { rpcUrl: process.env.HYP_RPC_URL_OPTIMISM! },
  });

  // Set signer for transactions
  multiProvider.setSharedSigner(
    new ethers.Wallet(process.env.HYP_KEY!).connect(
      multiProvider.getProvider(ORIGIN_CHAIN)
    )
  );

  // ===== Get chain addresses from registry =====
  const { Registry } = await import('@hyperlane-xyz/registry');
  const registry = new Registry({
    uri: 'https://github.com/hyperlane-xyz/hyperlane-registry',
    branch: 'main',
  });

  const originAddresses = await registry.getChainAddresses(ORIGIN_CHAIN);
  const destAddresses = await registry.getChainAddresses(DESTINATION_CHAIN);

  if (!originAddresses || !destAddresses) {
    throw new Error('Missing chain addresses in registry');
  }

  const addressesMap = {
    [ORIGIN_CHAIN]: { interchainAccountRouter: originAddresses.interchainAccountRouter },
    [DESTINATION_CHAIN]: { interchainAccountRouter: destAddresses.interchainAccountRouter },
  };

  // ===== Step 1: Get DAO's ICA address =====
  const ica = InterchainAccount.fromAddressesMap(addressesMap, multiProvider);
  const icaAddress = await ica.getAccount(DESTINATION_CHAIN, {
    origin: ORIGIN_CHAIN,
    owner: DAO_GOVERNOR,
  });
  console.log(\\\n=== Step 1: ICA Address ===\);
  console.log('ICA on', DESTINATION_CHAIN + ':', icaAddress);

  // ===== Step 2: Send funds to ICA =====
  console.log(\\\n=== Step 2: Fund the ICA ===\);
  console.log('Send ETH to:', icaAddress);
  console.log('Chain:', DESTINATION_CHAIN);

  // ===== Step 3: Generate proposal calldata =====
  console.log(\\\n=== Step 3: Proposal Calldata ===\);
  const proposalTx = await ica.getCallRemote({
    chain: ORIGIN_CHAIN,
    destination: DESTINATION_CHAIN,
    innerCalls: [
      {
        to: addressToBytes32(RECIPIENT),
        value: ethers.parseEther('0.05'),
        data: '0x',
      },
    ],
    config: {
      origin: ORIGIN_CHAIN,
      owner: DAO_GOVERNOR,
    },
  });

  console.log(\Target (ICA Router on \):\, proposalTx.to);
  console.log("Calldata:", proposalTx.data);
  console.log("Required ETH (IGP fee):", ethers.formatEther(proposalTx.value || 0));
  console.log("\nCreate proposal on Tally with this calldata.");
}

main().catch(console.error);
```

Run it:

```bash
cd typescript/cli
npx ts-node ../scripts/ica-tally-demo.ts
```

---

## Important Considerations

### Gas and Fee Payments
- The proposal transaction must include ETH for the Interchain Gas Payment (IGP)
- The ICA itself needs ETH/gas tokens on the destination chain to execute calls
- Relayer tips are paid from the IGP; higher tips = faster delivery

### Security
- Only the ICA owner (DAO Governor) can initiate calls through the ICA
- The ICA uses Hyperlane's ISM (Interchain Security Module) for message verification
- Consider using a timelock between proposal execution and fund movement

### Deterministic Addresses
- The ICA address is the same regardless of whether the account has been deployed
- You can safely send funds to an undeployed ICA address — deploy it later with `deployAccount()`

### Multiple Destination Chains
- Deploy ICAs on multiple chains to create a cross-chain DAO treasury
- Use the same owner (DAO Governor) for consistent address derivation

---

## Reference

- [Hyperlane ICA Contracts](/solidity/contracts/middleware/InterchainAccountRouter.sol)
- [Hyperlane ICA SDK](/typescript/sdk/src/middleware/account/InterchainAccount.ts)
- [Hyperlane CLI ICA Commands](/typescript/cli/src/commands/ica.ts)
- [Hyperlane Docs](https://docs.hyperlane.xyz)
- [Tally Governance](https://www.tally.xyz/)
