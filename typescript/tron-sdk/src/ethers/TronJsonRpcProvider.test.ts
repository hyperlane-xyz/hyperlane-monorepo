import { expect } from 'chai';
import { JsonRpcProvider } from 'ethers';

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

  it('falls back to the base provider for non-latest balance lookups', async () => {
    const originalGetBalance = JsonRpcProvider.prototype.getBalance;
    const provider = new TronJsonRpcProvider('http://127.0.0.1:19090');

    JsonRpcProvider.prototype.getBalance = async function (
      address: unknown,
      blockTag: unknown,
    ) {
      expect(address).to.equal('0x1111111111111111111111111111111111111111');
      expect(blockTag).to.equal(123n);
      return 456n;
    };

    try {
      const balance = await provider.getBalance(
        '0x1111111111111111111111111111111111111111',
        123n,
      );

      expect(balance).to.equal(456n);
    } finally {
      JsonRpcProvider.prototype.getBalance = originalGetBalance;
    }
  });

  it('falls back to the base provider for non-string addresses', async () => {
    const originalGetBalance = JsonRpcProvider.prototype.getBalance;
    const provider = new TronJsonRpcProvider('http://127.0.0.1:19090');
    const addressLike = {
      getAddress: async () => '0x1111111111111111111111111111111111111111',
    };

    JsonRpcProvider.prototype.getBalance = async function (address: unknown) {
      expect(address).to.equal(addressLike);
      return 789n;
    };

    try {
      const balance = await provider.getBalance(addressLike as any);

      expect(balance).to.equal(789n);
    } finally {
      JsonRpcProvider.prototype.getBalance = originalGetBalance;
    }
  });

  it('normalizes 41-prefixed hex addresses to base58 before latest balance lookups', async () => {
    const provider = new TronJsonRpcProvider('http://127.0.0.1:19090');
    let requestedAddress = '';

    (provider as any).tronWeb = {
      address: {
        fromHex: (value: string) => {
          expect(value).to.equal(`41${'1'.repeat(40)}`);
          return 'TConvertedAddress';
        },
      },
      trx: {
        getBalance: async (address: string) => {
          requestedAddress = address;
          return 321;
        },
      },
    };

    const balance = await provider.getBalance(`41${'1'.repeat(40)}`);

    expect(balance).to.equal(321n);
    expect(requestedAddress).to.equal('TConvertedAddress');
  });

  it('passes base58 addresses through unchanged for latest balance lookups', async () => {
    const provider = new TronJsonRpcProvider('http://127.0.0.1:19090');
    let requestedAddress = '';

    (provider as any).tronWeb = {
      address: {
        fromHex: (_value: string) => {
          throw new Error('fromHex should not be called');
        },
      },
      trx: {
        getBalance: async (address: string) => {
          requestedAddress = address;
          return 654;
        },
      },
    };

    const balance = await provider.getBalance(
      'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
    );

    expect(balance).to.equal(654n);
    expect(requestedAddress).to.equal('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb');
  });

  it('retries raw json-rpc transport calls', async () => {
    const originalSend = JsonRpcProvider.prototype._send;
    const provider = new TronJsonRpcProvider('http://127.0.0.1:19090');
    let attempts = 0;

    JsonRpcProvider.prototype._send = async function () {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return [{ id: 1, jsonrpc: '2.0', result: '0x1' } as any];
    };

    try {
      const result = await provider._send({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_chainId',
        params: [],
      } as any);

      expect(result[0]?.result).to.equal('0x1');
      expect(attempts).to.equal(2);
    } finally {
      JsonRpcProvider.prototype._send = originalSend;
    }
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
