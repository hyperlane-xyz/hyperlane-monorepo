import { expect } from 'chai';

import { TronJsonRpcProvider } from './TronJsonRpcProvider.js';

describe('TronJsonRpcProvider', () => {
  it('retries latest balance lookups via TronWeb', async () => {
    const provider = new TronJsonRpcProvider('http://127.0.0.1:19090');
    let attempts = 0;

    (provider as any).tronWeb = {
      address: {
        fromHex: (_value: string) => 'TTestAddress',
      },
      trx: {
        getBalance: async (_address: string) => {
          attempts += 1;
          if (attempts < 2) throw new Error('transient');
          return 123;
        },
      },
    };

    const balance = await provider.getBalance(
      '0x1111111111111111111111111111111111111111',
    );

    expect(balance).to.equal(123n);
    expect(attempts).to.equal(2);
  });

  it('returns legacy fee data from eth_gasPrice', async () => {
    const provider = new TronJsonRpcProvider('http://127.0.0.1:19090');

    (provider as any).send = async () => '0x7b';

    const feeData = await provider.getFeeData();

    expect(feeData.gasPrice).to.equal(123n);
    expect(feeData.maxFeePerGas).to.equal(null);
    expect(feeData.maxPriorityFeePerGas).to.equal(null);
  });
});
