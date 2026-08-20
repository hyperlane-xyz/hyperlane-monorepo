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
import {
  clearCachedStargateClients,
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
