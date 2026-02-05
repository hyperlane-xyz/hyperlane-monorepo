import {
  MetaTransactionData,
  OperationType,
} from '@safe-global/safe-core-sdk-types';
import { ethers } from 'ethers';
import {
  Hex,
  decodeFunctionData,
  getAddress,
  isHex,
  parseAbi,
} from 'viem';

import { ISafe__factory } from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';

import { SafeTxStatus } from './types.js';

/**
 * Parse a Safe transaction using the ISafe interface.
 * Decodes Safe contract function calls (swapOwner, addOwnerWithThreshold, etc.).
 *
 * @param tx - The annotated transaction to parse
 * @returns Decoded transaction description with function name and arguments
 */
export function parseSafeTx(tx: AnnotatedEV5Transaction) {
  const decoded = ISafe__factory.createInterface().parseTransaction({
    data: tx.data ?? '0x',
    value: tx.value,
  });
  return decoded;
}

/**
 * Converts a potentially non-prefixed hex string to a proper Hex type.
 * @param hex - The hex string (with or without 0x prefix)
 * @returns Properly prefixed Hex type
 */
export function asHex(hex?: string): Hex {
  return isHex(hex) ? (hex as Hex) : (`0x${hex}` as Hex);
}

/**
 * Decode a MultiSend transaction's data into individual transactions.
 * Based on Safe's MultiSend contract encoding format.
 *
 * The encoded format for each transaction is:
 * - 1 byte: operation (0 = Call, 1 = DelegateCall)
 * - 20 bytes: to address
 * - 32 bytes: value
 * - 32 bytes: data length
 * - N bytes: data
 *
 * @param encodedData - The encoded MultiSend data (calldata to multiSend function)
 * @returns Array of decoded transaction data
 */
export function decodeMultiSendData(
  encodedData: string,
): MetaTransactionData[] {
  const decodedData = decodeFunctionData({
    abi: parseAbi([
      'function multiSend(bytes memory transactions) public payable',
    ]),
    data: asHex(encodedData),
  });

  const args = decodedData.args;
  const txs: MetaTransactionData[] = [];

  // Decode after 0x
  let index = 2;

  if (args) {
    const [transactionBytes] = args;
    while (index < transactionBytes.length) {
      // As we are decoding hex encoded bytes calldata, each byte is represented by 2 chars
      // uint8 operation, address to, value uint256, dataLength uint256

      const operation = `0x${transactionBytes.slice(index, (index += 2))}`;
      const to = `0x${transactionBytes.slice(index, (index += 40))}`;
      const value = `0x${transactionBytes.slice(index, (index += 64))}`;
      const dataLength =
        parseInt(`${transactionBytes.slice(index, (index += 64))}`, 16) * 2;
      const data = `0x${transactionBytes.slice(index, (index += dataLength))}`;

      txs.push({
        operation: Number(operation) as OperationType,
        to: getAddress(to),
        value: BigInt(value).toString(),
        data,
      });
    }
  }

  return txs;
}

/**
 * Calculate the status of a Safe transaction based on confirmations.
 *
 * @param confirmations - Number of confirmations on the transaction
 * @param threshold - Required threshold for execution
 * @returns SafeTxStatus enum value
 */
export function getSafeTxStatus(
  confirmations: number,
  threshold: number,
): SafeTxStatus {
  if (confirmations >= threshold) {
    return SafeTxStatus.READY_TO_EXECUTE;
  }
  if (confirmations === 0) {
    return SafeTxStatus.NO_CONFIRMATIONS;
  }
  if (threshold - confirmations === 1) {
    return SafeTxStatus.ONE_AWAY;
  }
  return SafeTxStatus.PENDING;
}

/**
 * Calculate owner changes between current and expected owner sets.
 *
 * @param currentOwners - Current list of Safe owners
 * @param expectedOwners - Expected list of Safe owners
 * @returns Object with ownersToRemove and ownersToAdd arrays
 */
export async function getOwnerChanges(
  currentOwners: Address[],
  expectedOwners: Address[],
): Promise<{
  ownersToRemove: Address[];
  ownersToAdd: Address[];
}> {
  const ownersToRemove = currentOwners.filter(
    (owner) => !expectedOwners.some((newOwner) => eqAddress(owner, newOwner)),
  );
  const ownersToAdd = expectedOwners.filter(
    (newOwner) => !currentOwners.some((owner) => eqAddress(newOwner, owner)),
  );

  return { ownersToRemove, ownersToAdd };
}

/**
 * Format function fragment arguments into a readable record.
 *
 * @param args - The decoded function arguments (Result type from ethers)
 * @param fragment - The function fragment describing the arguments
 * @returns Record mapping argument names to their values
 */
export function formatFunctionFragmentArgs(
  args: ethers.utils.Result,
  fragment: ethers.utils.FunctionFragment,
): Record<string, unknown> {
  const accumulator: Record<string, unknown> = {};
  return fragment.inputs.reduce((acc, input, index) => {
    acc[input.name] = args[index];
    return acc;
  }, accumulator);
}

/**
 * Format operation type to human-readable string.
 *
 * @param operation - The OperationType enum value
 * @returns Human-readable operation name
 */
export function formatOperationType(operation: OperationType | undefined): string {
  switch (operation) {
    case OperationType.Call:
      return 'Call';
    case OperationType.DelegateCall:
      return 'Delegate Call';
    default:
      return 'Unknown';
  }
}

/**
 * Convert MetaTransactionData to AnnotatedEV5Transaction.
 *
 * @param metaTx - The meta transaction data from MultiSend decoding
 * @returns AnnotatedEV5Transaction for further processing
 */
export function metaTransactionDataToEV5Transaction(
  metaTx: MetaTransactionData,
): AnnotatedEV5Transaction {
  return {
    to: metaTx.to,
    value: ethers.BigNumber.from(metaTx.value),
    data: metaTx.data,
  };
}
