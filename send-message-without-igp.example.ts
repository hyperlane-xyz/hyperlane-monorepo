/**
 * Example: Send messages without paying for IGP (Interchain Gas Paymaster)
 * 
 * This script demonstrates how to send messages using a no-op hook instead
 * of the default IGP hook, which allows you to dispatch messages without
 * paying for gas on the destination chain.
 * 
 * Key points:
 * - The requiredHook (MerkleTreeHook) has a fee of 0
 * - By using a no-op hook (TestPostDispatchHook with fee=0), you bypass IGP
 * - You can send with value: 0 and the message will still be dispatched
 * - The message will NOT be automatically delivered (no gas paid)
 * - Perfect for testing undeliverable messages
 */

import { HyperlaneCore } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { ethers } from 'ethers';
// Note: TestPostDispatchHook is a test contract - you may need to deploy it yourself
// or use an existing no-op hook if one is deployed on testnet

/**
 * Step 1: Deploy a no-op hook (TestPostDispatchHook)
 * This hook has fee=0 by default, so it won't charge anything
 * 
 * You'll need to compile and deploy TestPostDispatchHook.sol from:
 * solidity/contracts/test/TestPostDispatchHook.sol
 */
async function deployNoopHook(signer: ethers.Signer) {
  // Option A: If you have the compiled artifact
  // const factory = new ethers.ContractFactory(
  //   TestPostDispatchHookABI,
  //   TestPostDispatchHookBytecode,
  //   signer
  // );
  
  // Option B: Deploy using Hardhat/Forge
  // forge create TestPostDispatchHook --rpc-url <testnet-rpc>
  
  // For now, you'll need to provide the address of an already-deployed hook
  // or deploy it manually
  throw new Error('Deploy TestPostDispatchHook first - see solidity/contracts/test/TestPostDispatchHook.sol');
}

/**
 * Step 2: Send message using the no-op hook
 * This bypasses IGP payment entirely
 */
async function sendMessageWithoutIGP(
  core: HyperlaneCore,
  multiProvider: MultiProvider,
  origin: string,
  destination: string,
  recipient: string,
  body: string,
  noopHookAddress: string
) {
  // Quote will be 0 (requiredHook=0 + noopHook=0)
  const quote = await core.quoteGasPayment(
    origin,
    destination,
    ethers.utils.hexZeroPad(recipient, 32),
    body,
    '0x0001', // default metadata
    noopHookAddress
  );

  console.log('Quote (should be 0):', quote.toString());

  // Send message with no-op hook and value: 0
  const { dispatchTx, message } = await core.sendMessage(
    origin,
    destination,
    recipient,
    body,
    noopHookAddress, // Use no-op hook instead of default IGP
    '0x0001'
  );

  console.log('Message dispatched (no IGP paid):', message.id);
  console.log('Transaction:', dispatchTx.transactionHash);
  console.log('Note: This message will NOT be automatically delivered');
  
  return { dispatchTx, message };
}

/**
 * Alternative: Call Mailbox directly for more control
 */
async function sendMessageDirectly(
  core: HyperlaneCore,
  multiProvider: MultiProvider,
  origin: string,
  destination: string,
  recipient: string,
  body: string,
  noopHookAddress: string
) {
  const mailbox = core.getContracts(origin).mailbox;
  const destinationDomain = multiProvider.getDomainId(destination);
  const recipientBytes32 = ethers.utils.hexZeroPad(recipient, 32);

  // Quote should be 0
  const quote = await mailbox['quoteDispatch(uint32,bytes32,bytes,bytes,address)'](
    destinationDomain,
    recipientBytes32,
    body,
    '0x0001',
    noopHookAddress
  );

  console.log('Quote:', quote.toString());

  // Dispatch with value: 0 (no IGP payment)
  const tx = await mailbox['dispatch(uint32,bytes32,bytes,bytes,address)'](
    destinationDomain,
    recipientBytes32,
    body,
    '0x0001',
    noopHookAddress,
    { value: 0 } // Can send with 0 value!
  );

  const receipt = await tx.wait();
  console.log('Dispatched without IGP:', receipt.transactionHash);
  
  return receipt;
}

/**
 * Complete example workflow
 */
async function example() {
  // Initialize
  const multiProvider = new MultiProvider(/* your chain config */);
  const core = HyperlaneCore.fromAddressesMap(
    /* your addresses map */,
    multiProvider
  );
  const signer = multiProvider.getSigner('sepolia'); // or your origin chain

  // Step 1: Deploy no-op hook (only needed once per chain)
  const noopHookAddress = await deployNoopHook(signer);
  // Or use an existing one if already deployed

  // Step 2: Send messages without IGP
  // For undeliverable messages, use an invalid recipient or one that will revert
  await sendMessageWithoutIGP(
    core,
    multiProvider,
    'sepolia',
    'mumbai',
    '0x000000000000000000000000000000000000dead', // Invalid recipient for undeliverable
    '0xdeadbeef', // Your message body
    noopHookAddress
  );
}
