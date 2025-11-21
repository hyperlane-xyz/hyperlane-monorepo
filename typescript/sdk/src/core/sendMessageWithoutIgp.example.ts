/**
 * Example: Sending messages without IGP payment on testnet
 * 
 * This creates "undeliverable" messages that are dispatched but won't be automatically relayed
 * unless someone manually pays for gas.
 */

import { HyperlaneCore, sendMessageWithoutIgp } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';

async function example() {
  // Initialize your multiProvider and core (same as normal usage)
  const multiProvider = new MultiProvider(/* your config */);
  const chainAddresses = await registry.getAddresses(); // or however you get addresses
  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

  // Option 1: Let the function find MerkleTreeHook automatically
  const { dispatchTx, message } = await sendMessageWithoutIgp(
    core,
    'arbitrumsepolia', // origin chain
    'optimismsepolia',  // destination chain
    '0x...',           // recipient address
    '0x1234',          // message body
  );

  console.log(`Message ID: ${message.id}`);
  console.log(`Transaction: ${dispatchTx.transactionHash}`);

  // Option 2: Explicitly provide MerkleTreeHook address
  const { dispatchTx: tx2, message: msg2 } = await sendMessageWithoutIgp(
    core,
    'arbitrumsepolia',
    'optimismsepolia',
    '0x...',
    '0x1234',
    '0xAD34A66Bf6dB18E858F6B686557075568c6E031C', // MerkleTreeHook address
  );
}
