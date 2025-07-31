import { TimelockController__factory } from '@hyperlane-xyz/core';
import { HexString } from '@hyperlane-xyz/utils';

import { TimelockTx } from '../types.js';

export function getTimelockExecutableTransactionFromBatch(
  transactionData: TimelockTx,
): HexString {
  const [to, data, value] = transactionData.data.reduce<
    [string[], string[], string[]]
  >(
    ([targets, data, values], item) => {
      targets.push(item.to);
      data.push(item.data);
      values.push(item.value?.toString() ?? '0');

      return [targets, data, values];
    },
    [[], [], []],
  );

  return TimelockController__factory.createInterface().encodeFunctionData(
    'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)',
    [to, value, data, transactionData.predecessor, transactionData.salt],
  );
}
