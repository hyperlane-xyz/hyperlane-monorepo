import { BigNumber } from 'ethers';
import type { providers } from 'ethers';

export function testTransactionReceipt(): providers.TransactionReceipt {
  return {
    to: '0x1111111111111111111111111111111111111111',
    from: '0x2222222222222222222222222222222222222222',
    contractAddress: '0x3333333333333333333333333333333333333333',
    transactionIndex: 0,
    gasUsed: BigNumber.from(0),
    logsBloom: '0x',
    blockHash: `0x${'00'.repeat(32)}`,
    transactionHash: `0x${'01'.repeat(32)}`,
    logs: [],
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: BigNumber.from(0),
    effectiveGasPrice: BigNumber.from(0),
    byzantium: true,
    type: 2,
    status: 1,
  };
}
