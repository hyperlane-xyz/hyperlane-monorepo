import { TransactionReceipt } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { Address, addressToBytes32, addBufferToGasLimit } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from './HyperlaneCore.js';
import { DispatchedMessage } from './types.js';
import { ChainName } from '../types.js';

// If no metadata is provided, ensure we provide a default of 0x0001.
// We set to 0x0001 instead of 0x0 to ensure it does not break on zksync.
const DEFAULT_METADATA = '0x0001';

/**
 * Sends a message without paying for IGP by using MerkleTreeHook instead of the default IGP hook.
 * This will create an "undeliverable" message that won't be relayed unless someone manually pays for gas.
 *
 * Note: This only works if the Mailbox's requiredHook also doesn't require payment (e.g., MerkleTreeHook).
 * If the requiredHook is IGP, this will revert. On most testnets, the requiredHook is MerkleTreeHook.
 *
 * @param core - The HyperlaneCore instance
 * @param origin - Origin chain name
 * @param destination - Destination chain name
 * @param recipient - Recipient address
 * @param body - Message body
 * @param merkleTreeHook - Optional MerkleTreeHook address. If not provided, will try to get from chain addresses.
 * @returns Transaction receipt and dispatched message
 */
export async function sendMessageWithoutIgp(
  core: HyperlaneCore,
  origin: ChainName,
  destination: ChainName,
  recipient: Address,
  body: string,
  merkleTreeHook?: Address,
): Promise<{ dispatchTx: TransactionReceipt; message: DispatchedMessage }> {
  const mailbox = core.getContracts(origin).mailbox;
  const destinationDomain = core.multiProvider.getDomainId(destination);
  const recipientBytes32 = addressToBytes32(recipient);

  // Get MerkleTreeHook address - it requires 0 value and quotes 0
  let hookAddress: Address;
  if (merkleTreeHook) {
    hookAddress = merkleTreeHook;
  } else {
    // Try to get from chain addresses - check if we have access to registry
    try {
      // Try to get from contractsMap if available (when using fromAddressesMap)
      const contracts = (core as any).contractsMap?.[origin];
      if (contracts?.merkleTreeHook) {
        hookAddress = contracts.merkleTreeHook.address || contracts.merkleTreeHook;
      } else {
        // Try to get from chain metadata
        const chainMetadata = await core.multiProvider.getChainMetadata(origin);
        const contractsFromMetadata = (chainMetadata as any).contracts;
        if (contractsFromMetadata?.merkleTreeHook) {
          hookAddress = contractsFromMetadata.merkleTreeHook;
        } else {
          throw new Error('MerkleTreeHook not found in chain addresses or metadata');
        }
      }
    } catch (e) {
      throw new Error(
        `MerkleTreeHook address not found for ${origin}. Please provide it explicitly. Error: ${e}`,
      );
    }
  }

  // Check what the requiredHook quotes - if it's > 0, we can't send without payment
  // We use quoteDispatch with MerkleTreeHook to see the total quote (requiredHook + MerkleTreeHook)
  // If MerkleTreeHook is the requiredHook, this should be 0
  const totalQuote = await mailbox.quoteDispatch(
    destinationDomain,
    recipientBytes32,
    body,
    DEFAULT_METADATA,
    hookAddress,
  );

  if (totalQuote.gt(0)) {
    // Check if it's just the requiredHook that requires payment
    const requiredHook = await mailbox.requiredHook();
    const requiredHookAddress = requiredHook.address;
    const isMerkleTreeRequiredHook = requiredHookAddress.toLowerCase() === hookAddress.toLowerCase();
    
    if (!isMerkleTreeRequiredHook) {
      throw new Error(
        `RequiredHook on ${origin} (${requiredHookAddress}) requires payment. ` +
          `Cannot send message without IGP payment. The requiredHook must be MerkleTreeHook (which quotes 0). ` +
          `Current total quote: ${totalQuote.toString()} wei.`,
      );
    }
  }

  const dispatchParams = [
    destinationDomain,
    recipientBytes32,
    body,
    DEFAULT_METADATA,
    hookAddress,
  ] as const;

  // MerkleTreeHook requires msg.value == 0, so we send with 0 value
  const estimateGas = await mailbox.estimateGas[
    'dispatch(uint32,bytes32,bytes,bytes,address)'
  ](...dispatchParams, { value: 0 });

  const dispatchTx = await core.multiProvider.handleTx(
    origin,
    mailbox['dispatch(uint32,bytes32,bytes,bytes,address)'](
      ...dispatchParams,
      {
        ...core.multiProvider.getTransactionOverrides(origin),
        value: 0, // No IGP payment
        gasLimit: addBufferToGasLimit(estimateGas),
      },
    ),
  );

  return {
    dispatchTx,
    message: core.getDispatchedMessages(dispatchTx)[0],
  };
}
