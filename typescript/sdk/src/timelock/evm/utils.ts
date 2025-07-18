import { TimelockController__factory } from '@hyperlane-xyz/core';
import { CallData, HexString } from '@hyperlane-xyz/utils';

type TimelockTx = {
  id: HexString;
  delay: number;
  predecessor: HexString;
  salt: HexString;
  data: [CallData, ...CallData[]];
};

export function getTimelockExecutableTransactionFromBatch(
  transactionData: TimelockTx,
): HexString {
  const [to, data, value] = transactionData.data.reduce(
    ([targets, data, values], item) => {
      targets.push(item.to);
      data.push(item.data);
      values.push(item.value?.toString() ?? '0');

      return [targets, data, values];
    },
    [[], [], []] as [string[], string[], string[]],
  );

  return TimelockController__factory.createInterface().encodeFunctionData(
    'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)',
    [to, value, data, transactionData.predecessor, transactionData.salt],
  );
}
