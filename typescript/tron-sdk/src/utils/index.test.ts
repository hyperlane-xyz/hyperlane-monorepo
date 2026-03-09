import { expect } from 'chai';

import {
  buildMetaProxyBytecode,
  convertEthersToTronTransaction,
  toTronHex,
} from './index.js';

describe('tron utils', () => {
  it('builds meta proxy bytecode for tron-prefixed implementation addresses', () => {
    const bytecode = buildMetaProxyBytecode(
      `41${'1'.repeat(40)}`,
      `0x${'ab'.repeat(4)}`,
    );

    expect(bytecode.startsWith('0x600b3803')).to.equal(true);
    expect(
      bytecode.includes('1111111111111111111111111111111111111111'),
    ).to.equal(true);
    expect(
      bytecode.endsWith(
        '0000000000000000000000000000000000000000000000000000000000000004',
      ),
    ).to.equal(true);
  });

  it('converts ethers-style contract calls into tron trigger transactions', async () => {
    const tronTx = { txID: '1'.repeat(64) };
    const calls: Array<{ to: string; options: any; sender: string }> = [];
    const tronWeb = {
      transactionBuilder: {
        triggerSmartContract: async (
          to: string,
          _selector: string,
          options: any,
          _params: Array<unknown>,
          sender: string,
        ) => {
          calls.push({ to, options, sender });
          return {
            result: { result: true },
            transaction: tronTx,
          };
        },
      },
    };

    const result = await convertEthersToTronTransaction(
      tronWeb as any,
      {
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        value: 5n,
      },
      'TTestSender',
    );

    expect(result).to.equal(tronTx);
    expect(calls).to.deep.equal([
      {
        to: toTronHex('0x1111111111111111111111111111111111111111'),
        options: { callValue: 5, input: '1234' },
        sender: 'TTestSender',
      },
    ]);
  });
});
