import {
  MetaTransactionData,
  OperationType,
} from '@safe-global/safe-core-sdk-types';
import { Hex, decodeFunctionData, getAddress, isHex, parseAbi } from 'viem';

import { ISafe__factory } from '@hyperlane-xyz/core';

import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';

export function parseSafeTx(tx: AnnotatedEV5Transaction) {
  const decoded = ISafe__factory.createInterface().parseTransaction({
    data: tx.data ?? '0x',
    value: tx.value,
  });

  return decoded;
}

// Copied from https://github.com/safe-global/safe-core-sdk/blob/201c50ef97ff5c48661cbe71a013ad7dc2866ada/packages/protocol-kit/src/utils/types.ts#L15-L17
export function asHex(hex?: string): Hex {
  return isHex(hex) ? (hex as Hex) : (`0x${hex}` as Hex);
}

// Copied from https://github.com/safe-global/safe-core-sdk/blob/201c50ef97ff5c48661cbe71a013ad7dc2866ada/packages/protocol-kit/src/utils/transactions/utils.ts#L159-L193
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
