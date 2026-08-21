import { expect } from 'chai';
import sinon from 'sinon';

import { StargateClient } from '@cosmjs/stargate';
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { BigNumber, providers as EthersV5Providers } from 'ethers';
import { createPublicClient, custom } from 'viem';

import { ProviderType, type ViemTransaction } from './ProviderType.js';
import { HyperlaneJsonRpcProvider } from './SmartProvider/HyperlaneJsonRpcProvider.js';
import { HyperlaneSmartProvider } from './SmartProvider/SmartProvider.js';
import {
  clearCachedStargateClients,
  estimateTransactionFeeEthersV5,
  estimateTransactionFeeCosmJsWasm,
  estimateTransactionFeeEthersV5ForGasUnits,
  estimateTransactionFeeSolanaWeb3,
  estimateTransactionFeeViem,
} from './transactionFeeEstimators.js';

const EVM_ADDRESS = '0x0000000000000000000000000000000000000001';
const EVM_HASH = `0x${'01'.repeat(32)}` as const;

describe('transactionFeeEstimators', () => {
  const sender = 'cosmos1sender';
  const senderPubKey = `02${'aa'.repeat(32)}`;
  const transaction = {
    type: ProviderType.CosmJsWasm,
    transaction: {
      contractAddress: 'cosmos1contract',
      msg: {},
      funds: [],
    },
  } as any;

  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    clearCachedStargateClients();
    sandbox.restore();
  });

  function makeEthersFeeProvider({
    gasPrice,
    maxFeePerGas,
  }: {
    gasPrice: bigint | null;
    maxFeePerGas: bigint | null;
  }): EthersV5Providers.Provider {
    const provider = new EthersV5Providers.JsonRpcProvider();
    sandbox.stub(provider, 'getFeeData').resolves({
      gasPrice: gasPrice === null ? null : BigNumber.from(gasPrice),
      lastBaseFeePerGas: null,
      maxFeePerGas: maxFeePerGas === null ? null : BigNumber.from(maxFeePerGas),
      maxPriorityFeePerGas: null,
    });
    return provider;
  }

  it('uses the EIP-1559 max fee as the total gas price cap', async () => {
    const estimate = await estimateTransactionFeeEthersV5ForGasUnits({
      provider: makeEthersFeeProvider({ gasPrice: 1n, maxFeePerGas: 2n }),
      gasUnits: 600_000n,
    });

    expect(estimate).to.deep.equal({
      gasUnits: 600_000n,
      gasPrice: 2n,
      fee: 1_200_000n,
    });
  });

  it('keeps zero-valued Ethers fee data as present', async () => {
    const estimate = await estimateTransactionFeeEthersV5ForGasUnits({
      provider: makeEthersFeeProvider({ gasPrice: 0n, maxFeePerGas: 0n }),
      gasUnits: 600_000n,
    });

    expect(estimate).to.deep.equal({
      gasUnits: 600_000n,
      gasPrice: 0n,
      fee: 0n,
    });
  });

  it('overrides the Ethers sender balance only when requested', async () => {
    const provider = makeEthersFeeProvider({
      gasPrice: 2n,
      maxFeePerGas: null,
    }) as EthersV5Providers.JsonRpcProvider;
    const estimateGas = sandbox
      .stub(provider, 'estimateGas')
      .resolves(BigNumber.from(21_000));
    const send = sandbox.stub(provider, 'send').resolves('0x5208');

    await estimateTransactionFeeEthersV5({
      transaction: { to: EVM_ADDRESS, value: BigNumber.from(1) },
      provider,
      sender: EVM_ADDRESS,
    });

    expect(estimateGas.calledOnce).to.equal(true);
    expect(send.notCalled).to.equal(true);
    estimateGas.resetHistory();

    const estimate = await estimateTransactionFeeEthersV5({
      transaction: { to: EVM_ADDRESS, value: BigNumber.from(1) },
      provider,
      sender: EVM_ADDRESS,
      ignoreSenderBalance: true,
    });

    expect(estimate).to.deep.equal({
      gasUnits: 21_000n,
      gasPrice: 2n,
      fee: 42_000n,
    });
    expect(estimateGas.notCalled).to.equal(true);
    expect(send.calledOnce).to.equal(true);
    expect(send.firstCall.args).to.deep.equal([
      'eth_estimateGas',
      [
        { from: EVM_ADDRESS, to: EVM_ADDRESS, value: '0x1' },
        'latest',
        { [EVM_ADDRESS]: { balance: `0x${'f'.repeat(64)}` } },
      ],
    ]);
  });

  it('routes Ethers balance overrides through the smart provider', async () => {
    const provider = new HyperlaneSmartProvider(1, [
      { http: 'http://provider' },
    ]);
    const perform = sandbox.stub(provider, 'perform').resolves('0x5208');
    sandbox.stub(provider, 'getFeeData').resolves({
      gasPrice: BigNumber.from(1),
      lastBaseFeePerGas: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    });

    await estimateTransactionFeeEthersV5({
      transaction: { to: EVM_ADDRESS, value: BigNumber.from(1) },
      provider,
      sender: EVM_ADDRESS,
      ignoreSenderBalance: true,
    });

    expect(perform.calledOnce).to.equal(true);
    expect(perform.firstCall.args[0]).to.equal('estimateGas');
    expect(perform.firstCall.args[1]).to.deep.equal({
      transaction: { from: EVM_ADDRESS, to: EVM_ADDRESS, value: '0x1' },
      stateOverride: {
        [EVM_ADDRESS]: { balance: `0x${'f'.repeat(64)}` },
      },
    });
  });

  it('serializes Ethers balance overrides for JSON-RPC', () => {
    const provider = new HyperlaneJsonRpcProvider(
      { http: 'http://provider' },
      { chainId: 1, name: 'test' },
    );
    const stateOverride = {
      [EVM_ADDRESS]: { balance: '0xffff' },
    };

    const [method, params] = provider.prepareRequest('estimateGas', {
      transaction: { from: EVM_ADDRESS, to: EVM_ADDRESS },
      stateOverride,
    });

    expect(method).to.equal('eth_estimateGas');
    expect(params).to.deep.equal([
      { from: EVM_ADDRESS, to: EVM_ADDRESS },
      'latest',
      stateOverride,
    ]);
  });

  it('keeps zero-valued Viem fee data as present', async () => {
    const client = createPublicClient({
      transport: custom({
        request: async () => {
          throw new Error('Unexpected RPC request');
        },
      }),
    });
    sandbox.stub(client, 'estimateGas').resolves(21_000n);
    sandbox.stub(client, 'estimateFeesPerGas').resolves({ gasPrice: 0n });
    const transaction = {
      blockHash: EVM_HASH,
      blockNumber: 1n,
      from: EVM_ADDRESS,
      gas: 21_000n,
      gasPrice: 0n,
      hash: EVM_HASH,
      input: '0x',
      nonce: 0,
      r: '0x',
      s: '0x',
      to: EVM_ADDRESS,
      transactionIndex: 0,
      type: 'legacy',
      typeHex: '0x0',
      v: 27n,
      value: 0n,
    } satisfies ViemTransaction['transaction'];

    const estimate = await estimateTransactionFeeViem({
      transaction: { type: ProviderType.Viem, transaction },
      provider: { type: ProviderType.Viem, provider: client },
      sender: EVM_ADDRESS,
    });

    expect(estimate).to.deep.equal({
      gasUnits: 21_000n,
      gasPrice: 0n,
      fee: 0n,
    });
  });

  it('overrides the Viem sender balance only when requested', async () => {
    const client = createPublicClient({
      transport: custom({
        request: async () => {
          throw new Error('Unexpected RPC request');
        },
      }),
    });
    const estimateGas = sandbox.stub(client, 'estimateGas').resolves(21_000n);
    sandbox.stub(client, 'estimateFeesPerGas').resolves({ gasPrice: 1n });
    const transaction = {
      blockHash: EVM_HASH,
      blockNumber: 1n,
      from: EVM_ADDRESS,
      gas: 21_000n,
      gasPrice: 1n,
      hash: EVM_HASH,
      input: '0x',
      nonce: 0,
      r: '0x',
      s: '0x',
      to: EVM_ADDRESS,
      transactionIndex: 0,
      type: 'legacy',
      typeHex: '0x0',
      v: 27n,
      value: 1n,
    } satisfies ViemTransaction['transaction'];

    await estimateTransactionFeeViem({
      transaction: { type: ProviderType.Viem, transaction },
      provider: { type: ProviderType.Viem, provider: client },
      sender: EVM_ADDRESS,
      ignoreSenderBalance: true,
    });

    expect(estimateGas.calledOnce).to.equal(true);
    expect(estimateGas.firstCall.args[0]).to.include({
      account: EVM_ADDRESS,
    });
    expect(estimateGas.firstCall.args[0].stateOverride).to.deep.equal([
      { address: EVM_ADDRESS, balance: (1n << 256n) - 1n },
    ]);
  });

  function makeProvider(url: string) {
    return {
      type: ProviderType.CosmJsWasm,
      provider: Promise.resolve({
        cometClient: {
          client: {
            url,
          },
        },
      }),
    } as any;
  }

  it('returns the Solana base fee when priority pricing is zero', async () => {
    const sender = Keypair.generate();
    const transaction = new Transaction({
      feePayer: sender.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
    }).add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    const connection = new Connection('http://localhost:8899');
    sandbox.stub(connection, 'simulateTransaction').resolves({
      context: { slot: 1 },
      value: { err: null, logs: null, unitsConsumed: 200_000 },
    });
    const getRecentPrioritizationFees = sandbox
      .stub(connection, 'getRecentPrioritizationFees')
      .resolves([{ prioritizationFee: 0, slot: 1 }]);
    const getFeeForMessage = sandbox
      .stub(connection, 'getFeeForMessage')
      .resolves({ context: { slot: 1 }, value: 5_000 });

    const estimate = await estimateTransactionFeeSolanaWeb3({
      transaction: { type: ProviderType.SolanaWeb3, transaction },
      provider: { type: ProviderType.SolanaWeb3, provider: connection },
    });

    expect(estimate).to.deep.equal({
      gasUnits: 200_000n,
      gasPrice: 0n,
      fee: 5_000n,
    });
    expect(getFeeForMessage.calledOnce).to.equal(true);
    expect(getRecentPrioritizationFees.notCalled).to.equal(true);
  });

  it('uses the message fee for versioned Solana transactions', async () => {
    const sender = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: sender.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        SystemProgram.transfer({
          fromPubkey: sender.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const connection = new Connection('http://localhost:8899');
    sandbox.stub(connection, 'simulateTransaction').resolves({
      context: { slot: 1 },
      value: { err: null, logs: null, unitsConsumed: 200_000 },
    });
    const getFeeForMessage = sandbox
      .stub(connection, 'getFeeForMessage')
      .resolves({ context: { slot: 1 }, value: 5_123 });

    const estimate = await estimateTransactionFeeSolanaWeb3({
      transaction: {
        type: ProviderType.SolanaWeb3,
        transaction: new VersionedTransaction(message),
      },
      provider: { type: ProviderType.SolanaWeb3, provider: connection },
    });

    expect(estimate.fee).to.equal(5_123n);
    expect(getFeeForMessage.calledOnceWithExactly(message)).to.equal(true);
  });

  it('gets the Solana message fee without simulating when requested', async () => {
    const sender = Keypair.generate();
    const transaction = new Transaction({
      feePayer: sender.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
    }).add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    const connection = new Connection('http://localhost:8899');
    const simulateTransaction = sandbox.stub(connection, 'simulateTransaction');
    sandbox
      .stub(connection, 'getFeeForMessage')
      .resolves({ context: { slot: 1 }, value: 5_000 });

    const estimate = await estimateTransactionFeeSolanaWeb3({
      transaction: { type: ProviderType.SolanaWeb3, transaction },
      provider: { type: ProviderType.SolanaWeb3, provider: connection },
      ignoreSenderBalance: true,
    });

    expect(estimate).to.deep.equal({
      gasUnits: 0n,
      gasPrice: 0n,
      fee: 5_000n,
    });
    expect(simulateTransaction.notCalled).to.equal(true);
  });

  function makeStargateClient(
    simulate: sinon.SinonStub,
  ): StargateClient & { disconnect: sinon.SinonStub } {
    return {
      disconnect: sandbox.stub(),
      getSequence: sandbox.stub().resolves({ sequence: 1 }),
      forceGetQueryClient: sandbox.stub().returns({
        tx: {
          simulate,
        },
      }),
    } as unknown as StargateClient & { disconnect: sinon.SinonStub };
  }

  async function estimate(url: string) {
    return estimateTransactionFeeCosmJsWasm({
      transaction,
      provider: makeProvider(url),
      estimatedGasPrice: '2',
      sender,
      senderPubKey,
    });
  }

  it('reuses cached Stargate clients for HTTP URLs', async () => {
    const simulate = sandbox.stub().resolves({ gasInfo: { gasUsed: 10 } });
    const client = makeStargateClient(simulate);
    const connect = sandbox.stub(StargateClient, 'connect').resolves(client);

    await estimate('https://cosmos-rpc.example');
    await estimate('https://cosmos-rpc.example');

    expect(
      connect.calledOnceWithExactly('https://cosmos-rpc.example'),
    ).to.equal(true);
    expect(simulate.calledTwice).to.equal(true);
  });

  it('evicts cached Stargate clients when simulation fails', async () => {
    const firstClient = makeStargateClient(
      sandbox.stub().rejects(new Error('socket has disconnected')),
    );
    const secondClient = makeStargateClient(
      sandbox.stub().resolves({ gasInfo: { gasUsed: 10 } }),
    );
    const connect = sandbox
      .stub(StargateClient, 'connect')
      .onFirstCall()
      .resolves(firstClient)
      .onSecondCall()
      .resolves(secondClient);

    try {
      await estimate('https://cosmos-rpc.example');
      throw new Error('Expected estimate to fail');
    } catch (error) {
      expect((error as Error).message).to.equal('socket has disconnected');
    }
    await estimate('https://cosmos-rpc.example');

    expect(connect.calledTwice).to.equal(true);
    expect(firstClient.disconnect.calledOnce).to.equal(true);
  });

  it('does not cache Stargate clients for WebSocket URLs', async () => {
    const firstClient = makeStargateClient(
      sandbox.stub().resolves({ gasInfo: { gasUsed: 10 } }),
    );
    const secondClient = makeStargateClient(
      sandbox.stub().resolves({ gasInfo: { gasUsed: 10 } }),
    );
    const connect = sandbox
      .stub(StargateClient, 'connect')
      .onFirstCall()
      .resolves(firstClient)
      .onSecondCall()
      .resolves(secondClient);

    await estimate('wss://cosmos-rpc.example');
    await estimate('wss://cosmos-rpc.example');

    expect(connect.calledTwice).to.equal(true);
    expect(firstClient.disconnect.calledOnce).to.equal(true);
    expect(secondClient.disconnect.calledOnce).to.equal(true);
  });
});
