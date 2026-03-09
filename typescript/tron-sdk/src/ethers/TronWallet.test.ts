import { expect } from 'chai';

import { TronWallet } from './TronWallet.js';

describe('TronWallet', () => {
  it('preserves the TronWallet type when connecting', () => {
    const wallet = new TronWallet(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      'http://127.0.0.1:19090',
    );

    const connected = wallet.connect(null);

    expect(connected).to.be.instanceOf(TronWallet);
  });

  it('returns the ethers response augmented with the raw tron transaction', async () => {
    const wallet = new TronWallet(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      'http://127.0.0.1:19090',
    );

    const tronTx = {
      txID: 'a'.repeat(64),
      raw_data: {},
      raw_data_hex: '0x',
      contract_address: `41${'b'.repeat(40)}`,
    };

    (wallet as any).populateTransaction = async () => ({
      data: '0x6000',
      gasLimit: 100_000n,
      gasPrice: 1n,
      chainId: 1n,
      value: 0n,
    });
    (wallet as any).tronWeb = {
      transactionBuilder: {
        createSmartContract: async () => tronTx,
        alterTransaction: async (tx: any) => tx,
      },
      trx: {
        sign: async (tx: any) => tx,
        sendRawTransaction: async () => ({ result: true }),
      },
      address: {
        toHex: (_value: string) => `41${'1'.repeat(40)}`,
        fromPrivateKey: (_value: string) => 'TTestAddress',
      },
      setPrivateKey: (_value: string) => undefined,
      setAddress: (_value: string) => undefined,
    };
    (wallet.provider as any).getTransaction = async (hash: string) => ({
      hash,
      wait: async () => null,
    });

    const response = await wallet.sendTransaction({});

    expect(response.hash).to.equal(`0x${'a'.repeat(64)}`);
    expect((response as any).tronTransaction).to.equal(tronTx);
    expect(wallet.getTronTransaction(response.hash)).to.equal(tronTx);
  });

  it('retries broadcasts when tron reports a contract address collision', async () => {
    const wallet = new TronWallet(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      'http://127.0.0.1:19090',
    );

    let broadcastAttempts = 0;
    let alterCount = 0;

    (wallet as any).populateTransaction = async () => ({
      data: '0x6000',
      gasLimit: 100_000n,
      gasPrice: 1n,
      chainId: 1n,
      value: 0n,
    });
    (wallet as any).tronWeb = {
      transactionBuilder: {
        createSmartContract: async () => ({
          txID: `${(alterCount + 1).toString(16).padStart(64, '0')}`,
          raw_data: {},
          raw_data_hex: '0x',
          contract_address: `41${'c'.repeat(40)}`,
        }),
        alterTransaction: async (_tx: any) => {
          alterCount += 1;
          return {
            txID: `${alterCount.toString(16).padStart(64, '0')}`,
            raw_data: {},
            raw_data_hex: '0x',
            contract_address: `41${'c'.repeat(40)}`,
          };
        },
      },
      trx: {
        sign: async (tx: any) => tx,
        sendRawTransaction: async () => {
          broadcastAttempts += 1;
          if (broadcastAttempts === 1) {
            return {
              result: false,
              message: Buffer.from(
                'Trying to create a contract with existing contract address',
                'utf8',
              ).toString('hex'),
            };
          }
          return { result: true };
        },
      },
      address: {
        toHex: (_value: string) => `41${'1'.repeat(40)}`,
        fromPrivateKey: (_value: string) => 'TTestAddress',
      },
      setPrivateKey: (_value: string) => undefined,
      setAddress: (_value: string) => undefined,
    };
    (wallet.provider as any).getTransaction = async (hash: string) => ({
      hash,
      wait: async () => null,
    });

    const response = await wallet.sendTransaction({});

    expect(response.hash).to.equal(
      `0x${broadcastAttempts.toString(16).padStart(64, '0')}`,
    );
    expect(broadcastAttempts).to.equal(2);
    expect(alterCount).to.equal(2);
  });
});
