import { expect } from 'chai';

import { TronTransactionBuilder, TronWallet } from './TronWallet.js';

describe('TronWallet', () => {
  const privateKey =
    '0x1111111111111111111111111111111111111111111111111111111111111111';
  const tronUrl = 'http://127.0.0.1:19090';

  it('preserves the TronWallet type when connecting', () => {
    const wallet = new TronWallet(privateKey, tronUrl);

    const connected = wallet.connect(null);

    expect(connected).to.be.instanceOf(TronWallet);
  });

  it('returns the ethers response augmented with the raw tron transaction', async () => {
    const wallet = new TronWallet(privateKey, tronUrl);

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
    const wallet = new TronWallet(privateKey, tronUrl);

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

  it('sends simple transfers via sendTrx', async () => {
    const wallet = new TronWallet(privateKey, tronUrl);
    const calls: Array<{ to: string; value: number; from: string }> = [];

    (wallet as any).populateTransaction = async () => ({
      to: '0x1111111111111111111111111111111111111111',
      data: '0x',
      gasPrice: 1n,
      gasLimit: 21_000n,
      value: 5n,
    });
    (wallet as any).tronWeb = {
      transactionBuilder: {
        sendTrx: async (to: string, value: number, from: string) => {
          calls.push({ to, value, from });
          return {
            txID: 'd'.repeat(64),
            raw_data: {},
            raw_data_hex: '0x',
          };
        },
        alterTransaction: async (tx: any) => tx,
      },
      trx: {
        sign: async (tx: any) => tx,
        sendRawTransaction: async () => ({ result: true }),
      },
      address: {
        fromHex: (value: string) => `T${value.slice(-8)}`,
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

    const response = await wallet.sendTransaction({
      to: '0x1111111111111111111111111111111111111111',
      value: 5n,
    });

    expect(response.hash).to.equal(`0x${'d'.repeat(64)}`);
    expect(calls).to.deep.equal([
      {
        to: `T${'1'.repeat(8)}`,
        value: 5,
        from: (wallet as any).tronAddress,
      },
    ]);
  });

  it('sends contract calls via triggerSmartContract', async () => {
    const wallet = new TronWallet(privateKey, tronUrl);
    const calls: Array<{ to: string; options: any; from: string }> = [];

    (wallet as any).populateTransaction = async () => ({
      to: '0x1111111111111111111111111111111111111111',
      data: '0x1234',
      gasPrice: 2n,
      gasLimit: 50_000n,
      value: 7n,
    });
    (wallet as any).tronWeb = {
      transactionBuilder: {
        triggerSmartContract: async (
          to: string,
          _selector: string,
          options: any,
          _params: Array<unknown>,
          from: string,
        ) => {
          calls.push({ to, options, from });
          return {
            result: { result: true },
            transaction: {
              txID: 'e'.repeat(64),
              raw_data: {},
              raw_data_hex: '0x',
            },
          };
        },
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

    const response = await wallet.sendTransaction({
      to: '0x1111111111111111111111111111111111111111',
      data: '0x1234',
      value: 7n,
    });

    expect(response.hash).to.equal(`0x${'e'.repeat(64)}`);
    expect(calls).to.deep.equal([
      {
        to: `41${'1'.repeat(40)}`,
        options: {
          feeLimit: 150000,
          callValue: 7,
          input: '1234',
        },
        from: (wallet as any).tronAddress,
      },
    ]);
  });
});

describe('TronTransactionBuilder', () => {
  const tronUrl = 'http://127.0.0.1:19090';
  const tronAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

  it('formats ethers responses with tron metadata', async () => {
    const builder = new TronTransactionBuilder(tronUrl, tronAddress);
    let waitedFor: { hash: string; confirmations?: number } | undefined;

    (builder as any).tronAddressHex = `41${'1'.repeat(40)}`;
    (builder as any).provider = {
      waitForTransaction: async (hash: string, confirmations?: number) => {
        waitedFor = { hash, confirmations };
        return { status: 1 };
      },
    };

    const response = builder.getTransactionResponse(
      {
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        gasLimit: 10n,
        gasPrice: 20n,
        value: 30n,
        chainId: 40n,
      },
      { txID: 'a'.repeat(64) } as any,
      `0x${'b'.repeat(64)}`,
    );

    expect(response.hash).to.equal(`0x${'b'.repeat(64)}`);
    expect(response.from).to.equal(
      '0x1111111111111111111111111111111111111111',
    );
    expect(response.gasLimit).to.equal(10n);
    expect(response.gasPrice).to.equal(20n);
    expect(response.value).to.equal(30n);
    expect(response.chainId).to.equal(40n);
    expect(await response.wait(2)).to.deep.equal({ status: 1 });
    expect(waitedFor).to.deep.equal({
      hash: `0x${'b'.repeat(64)}`,
      confirmations: 2,
    });
  });

  it('routes buildTransaction to deployment, contract call, and transfer builders', async () => {
    const builder = new TronTransactionBuilder(tronUrl, tronAddress);
    const calls: string[] = [];

    (builder as any).buildDeployment = async () => {
      calls.push('deploy');
      return { txID: '1'.repeat(64) };
    };
    (builder as any).buildContractCall = async () => {
      calls.push('call');
      return { txID: '2'.repeat(64) };
    };
    (builder as any).buildTransfer = async () => {
      calls.push('transfer');
      return { txID: '3'.repeat(64) };
    };

    await builder.buildTransaction({
      data: '0x1234',
      gasPrice: 2n,
      gasLimit: 3n,
    });
    await builder.buildTransaction({
      to: '0x1111111111111111111111111111111111111111',
      data: '0x1234',
      gasPrice: 2n,
      gasLimit: 3n,
    });
    await builder.buildTransaction({
      to: '0x1111111111111111111111111111111111111111',
      value: 1n,
      gasPrice: 2n,
      gasLimit: 3n,
    });

    expect(calls).to.deep.equal(['deploy', 'call', 'transfer']);
  });

  it('builds deployment transactions', async () => {
    const builder = new TronTransactionBuilder(tronUrl, tronAddress);
    let request: any;

    (builder as any).transactionBuilder = {
      createSmartContract: async (config: any, from: string) => {
        request = { config, from };
        return { txID: '1'.repeat(64) };
      },
    };

    const result = await (builder as any).buildDeployment(
      { data: '0x1234' },
      100,
      5,
      200,
    );

    expect((result as any).txID).to.equal('1'.repeat(64));
    expect(request).to.deep.equal({
      config: {
        abi: [],
        bytecode: '1234',
        feeLimit: 100,
        callValue: 5,
        originEnergyLimit: 200,
      },
      from: tronAddress,
    });
  });

  it('builds contract call transactions', async () => {
    const builder = new TronTransactionBuilder(tronUrl, tronAddress);
    let request: any;

    (builder as any).transactionBuilder = {
      triggerSmartContract: async (
        to: string,
        selector: string,
        options: any,
        params: Array<unknown>,
        from: string,
      ) => {
        request = { to, selector, options, params, from };
        return {
          result: { result: true },
          transaction: { txID: '2'.repeat(64) },
        };
      },
    };

    const result = await (builder as any).buildContractCall(
      {
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
      },
      100,
      5,
    );

    expect((result as any).txID).to.equal('2'.repeat(64));
    expect(request).to.deep.equal({
      to: `41${'1'.repeat(40)}`,
      selector: '',
      options: {
        feeLimit: 100,
        callValue: 5,
        input: '1234',
      },
      params: [],
      from: tronAddress,
    });
  });

  it('builds transfer transactions', async () => {
    const builder = new TronTransactionBuilder(tronUrl, tronAddress);
    let request: any;

    (builder as any).transactionBuilder = {
      sendTrx: async (to: string, value: number, from: string) => {
        request = { to, value, from };
        return { txID: '3'.repeat(64) };
      },
    };

    const result = await (builder as any).buildTransfer(
      '0x1111111111111111111111111111111111111111',
      5,
    );

    expect((result as any).txID).to.equal('3'.repeat(64));
    expect(request).to.deep.equal({
      to: `41${'1'.repeat(40)}`,
      value: 5,
      from: tronAddress,
    });
  });
});
