import { SendMessageResult } from '@ton/sandbox';
import { FlatTransactionComparable } from '@ton/test-utils';

export const expectTransactionFlow = (
  result: SendMessageResult,
  transactions: FlatTransactionComparable[],
) => {
  transactions.forEach((ex, i) => {
    try {
      expect([result.transactions[i + 1]]).toHaveTransaction({
        ...ex,
      });
    } catch (err) {
      console.log('Failed exp:', i);
      throw err;
    }
  });
};
