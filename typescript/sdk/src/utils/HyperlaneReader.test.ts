import { expect } from 'chai';
import { BigNumber, errors as EthersError, providers, utils } from 'ethers';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  HyperlaneSmartProvider,
  ProbeMissError,
} from '../providers/SmartProvider/SmartProvider.js';

import { HyperlaneReader } from './HyperlaneReader.js';

const TEST_ADDRESS = '0x0000000000000000000000000000000000000001';
const TEST_ADDRESS_2 = '0x0000000000000000000000000000000000000002';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const CUSTOM_BATCH_CONTRACT_ADDRESS =
  '0x00000000000000000000000000000000000000bA';
const TEST_INTERFACE = new utils.Interface([
  'function probe() view returns (address)',
  'function owner() view returns (address)',
]);
const MULTICALL3_INTERFACE = new utils.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
]);

class ReaderHarness extends HyperlaneReader {
  async testProbeContractCall(
    txOverrides: providers.TransactionRequest = {},
  ): Promise<string | undefined> {
    return this.probeContractCall<string>(
      TEST_ADDRESS,
      TEST_INTERFACE,
      'probe',
      [],
      txOverrides,
    );
  }

  async testProbeContractCallWithInterface(
    contractInterface: utils.Interface,
  ): Promise<string | undefined> {
    return this.probeContractCall<string>(
      TEST_ADDRESS,
      contractInterface,
      'probe',
    );
  }

  async testProbeEstimateGas(
    overrides: providers.TransactionRequest = {},
  ): Promise<BigNumber | undefined> {
    return this.probeContractEstimateGas({
      to: TEST_ADDRESS,
      ...overrides,
    });
  }

  async testReadContractBatch(): Promise<[string, string]> {
    return this.readContractBatch<string>([
      {
        target: TEST_ADDRESS,
        contractInterface: TEST_INTERFACE,
        method: 'probe',
      },
      {
        target: TEST_ADDRESS_2,
        contractInterface: TEST_INTERFACE,
        method: 'owner',
      },
    ]) as Promise<[string, string]>;
  }

  async testTryProbeContractBatch(): Promise<
    [string | undefined, string | undefined] | undefined
  > {
    return this.tryProbeContractBatch<string>([
      {
        target: TEST_ADDRESS,
        contractInterface: TEST_INTERFACE,
        method: 'probe',
      },
      {
        target: TEST_ADDRESS_2,
        contractInterface: TEST_INTERFACE,
        method: 'owner',
      },
    ]) as Promise<[string | undefined, string | undefined] | undefined>;
  }

  async testTryProbeContractBatchWithInterface(
    contractInterface: utils.Interface,
  ): Promise<[string | undefined, string | undefined] | undefined> {
    return this.tryProbeContractBatch<string>([
      {
        target: TEST_ADDRESS,
        contractInterface,
        method: 'probe',
      },
      {
        target: TEST_ADDRESS_2,
        contractInterface: TEST_INTERFACE,
        method: 'owner',
      },
    ]) as Promise<[string | undefined, string | undefined] | undefined>;
  }
}

class ProbeReaderProvider extends providers.BaseProvider {
  public lastCallTransaction?: providers.TransactionRequest;
  public lastEstimateGasTransaction?: providers.TransactionRequest;

  constructor(
    private readonly options: {
      callResult?: string;
      callError?: Error;
      estimateGasError?: Error;
    } = {},
  ) {
    super({ name: 'test', chainId: 1 });
  }

  async call(
    transaction: providers.TransactionRequest,
    _blockTag?: providers.BlockTag,
  ): Promise<string> {
    this.lastCallTransaction = transaction;
    if (this.options.callError) {
      throw this.options.callError;
    }

    return this.options.callResult ?? '0x';
  }

  async estimateGas(
    transaction: providers.TransactionRequest,
  ): Promise<BigNumber> {
    this.lastEstimateGasTransaction = transaction;
    if (this.options.estimateGasError) {
      throw this.options.estimateGasError;
    }

    return BigNumber.from(1);
  }

  async detectNetwork() {
    return { name: 'test', chainId: 1 };
  }
}

class ProbeMissSmartProvider extends HyperlaneSmartProvider {
  constructor() {
    super({ chainId: 1, name: 'test' }, [{ http: 'http://provider' }], []);
  }

  async probeCall(): Promise<string> {
    throw new ProbeMissError('probe miss');
  }

  async probeEstimateGas(): Promise<BigNumber> {
    throw new ProbeMissError('probe miss');
  }
}

class BatchReaderProvider extends providers.BaseProvider {
  public readonly callTransactions: providers.TransactionRequest[] = [];
  private remainingGetCodeFailures = 0;

  constructor(
    private readonly options: {
      supportsMulticall?: boolean;
      multicallError?: Error;
      multicallSecondFailure?: boolean;
      multicallResult?: string;
      batchContractAddress?: string;
      getCodeFailures?: number;
    } = {},
  ) {
    super({ name: 'test', chainId: 1 });
    this.remainingGetCodeFailures = options.getCodeFailures ?? 0;
  }

  private get batchContractAddress(): string {
    return this.options.batchContractAddress ?? MULTICALL3_ADDRESS;
  }

  async getCode(address: string): Promise<string> {
    if (this.remainingGetCodeFailures > 0) {
      this.remainingGetCodeFailures -= 1;
      throw new Error('temporary getCode failure');
    }

    return address.toLowerCase() === this.batchContractAddress.toLowerCase() &&
      this.options.supportsMulticall
      ? '0x1234'
      : '0x';
  }

  async call(
    transaction: providers.TransactionRequest,
    _blockTag?: providers.BlockTag,
  ): Promise<string> {
    this.callTransactions.push(transaction);

    if (
      transaction.to &&
      transaction.to.toLowerCase() === this.batchContractAddress.toLowerCase()
    ) {
      if (this.options.multicallError) {
        throw this.options.multicallError;
      }

      if (this.options.multicallResult !== undefined) {
        return this.options.multicallResult;
      }

      return MULTICALL3_INTERFACE.encodeFunctionResult('aggregate3', [
        [
          {
            success: true,
            returnData: TEST_INTERFACE.encodeFunctionResult('probe', [
              TEST_ADDRESS,
            ]),
          },
          this.options.multicallSecondFailure
            ? {
                success: false,
                returnData: '0x',
              }
            : {
                success: true,
                returnData: TEST_INTERFACE.encodeFunctionResult('owner', [
                  TEST_ADDRESS_2,
                ]),
              },
        ],
      ]);
    }

    if (!transaction.to) {
      throw new Error('missing target');
    }

    if (transaction.to.toLowerCase() === TEST_ADDRESS.toLowerCase()) {
      return TEST_INTERFACE.encodeFunctionResult('probe', [TEST_ADDRESS]);
    }

    if (transaction.to.toLowerCase() === TEST_ADDRESS_2.toLowerCase()) {
      return TEST_INTERFACE.encodeFunctionResult('owner', [TEST_ADDRESS_2]);
    }

    throw new Error(`unexpected target ${transaction.to}`);
  }

  async detectNetwork() {
    return { name: 'test', chainId: 1 };
  }
}

describe('HyperlaneReader', () => {
  let multiProvider: MultiProvider;

  beforeEach(() => {
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  it('returns undefined on deterministic probe misses from regular providers', async () => {
    const provider = new ProbeReaderProvider({
      callError: Object.assign(new Error('call revert exception'), {
        code: EthersError.CALL_EXCEPTION,
        data: '0x',
      }),
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testProbeContractCall();

    expect(result).to.be.undefined;
  });

  it('returns undefined on Tron-style deterministic probe misses from regular providers', async () => {
    const provider = new ProbeReaderProvider({
      callError: Object.assign(
        new Error('missing revert data in call exception'),
        {
          code: EthersError.CALL_EXCEPTION,
          data: '0x',
          error: {
            error: {
              code: -32000,
              data: '{}',
            },
          },
        },
      ),
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testProbeContractCall();

    expect(result).to.be.undefined;
  });

  it('returns undefined when the RPC body nests ServerError(3) for regular providers', async () => {
    const provider = new ProbeReaderProvider({
      callError: Object.assign(
        new Error('missing revert data in call exception'),
        {
          code: EthersError.CALL_EXCEPTION,
          data: '0x',
          error: {
            code: EthersError.SERVER_ERROR,
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: {
                code: -32603,
                message:
                  'ErrorObject { code: ServerError(3), message: "execution reverted", data: None }',
              },
            }),
          },
        },
      ),
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testProbeContractCall();

    expect(result).to.be.undefined;
  });

  it('returns undefined when decoding probe results surfaces revert data as CALL_EXCEPTION', async () => {
    const provider = new ProbeReaderProvider({
      callResult:
        '0x08c379a000000000000000000000000000000000000000000000000000000000' +
        '0000002000000000000000000000000000000000000000000000000000000000' +
        '0000002146696174546f6b656e3a2063616c6c6572206973206e6f742061206d' +
        '696e746572000000000000000000000000000000000000000000000000000000',
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testProbeContractCall();

    expect(result).to.be.undefined;
  });

  it('returns undefined when decoding probe results hits BUFFER_OVERRUN', async () => {
    const provider = new ProbeReaderProvider({
      callResult:
        '0x0000000000000000000000000000000000000000000000000000000000000001',
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);
    const interfaceWithBufferOverrun = Object.assign(
      Object.create(TEST_INTERFACE),
      {
        decodeFunctionResult: () => {
          throw Object.assign(new Error('data out-of-bounds'), {
            code: EthersError.BUFFER_OVERRUN,
          });
        },
      },
    ) as utils.Interface;

    const result = await reader.testProbeContractCallWithInterface(
      interfaceWithBufferOverrun,
    );

    expect(result).to.be.undefined;
  });

  it('returns undefined on ProbeMissError from smart providers', async () => {
    multiProvider.setProvider(
      TestChainName.test1,
      new ProbeMissSmartProvider(),
    );
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const [callResult, gasResult] = await Promise.all([
      reader.testProbeContractCall(),
      reader.testProbeEstimateGas(),
    ]);

    expect(callResult).to.be.undefined;
    expect(gasResult).to.be.undefined;
  });

  it('surfaces transport failures during probe calls', async () => {
    const provider = new ProbeReaderProvider({
      callError: Object.assign(new Error('connection refused'), {
        code: EthersError.SERVER_ERROR,
      }),
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    try {
      await reader.testProbeContractCall();
      expect.fail('Expected probe call to throw');
    } catch (error) {
      expect(String(error)).to.include('connection refused');
    }
  });

  it('returns undefined on deterministic estimateGas misses', async () => {
    const provider = new ProbeReaderProvider({
      estimateGasError: Object.assign(
        new Error('cannot estimate gas; transaction may fail'),
        {
          code: EthersError.UNPREDICTABLE_GAS_LIMIT,
        },
      ),
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testProbeEstimateGas();

    expect(result).to.be.undefined;
  });

  it('applies chain transaction overrides to probe calls and estimates', async () => {
    multiProvider = new MultiProvider({
      ...multiProvider.metadata,
      [TestChainName.test1]: {
        ...multiProvider.metadata[TestChainName.test1],
        transactionOverrides: { type: 0, from: TEST_ADDRESS_2 },
      },
    });
    const provider = new ProbeReaderProvider({
      callResult:
        '0x0000000000000000000000000000000000000000000000000000000000000001',
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    await Promise.all([
      reader.testProbeContractCall({ from: TEST_ADDRESS }),
      reader.testProbeEstimateGas({ from: TEST_ADDRESS }),
    ]);

    expect(provider.lastCallTransaction?.type).to.equal(0);
    expect(provider.lastCallTransaction?.from).to.equal(TEST_ADDRESS);
    expect(provider.lastEstimateGasTransaction?.type).to.equal(0);
    expect(provider.lastEstimateGasTransaction?.from).to.equal(TEST_ADDRESS);
  });

  it('strips gas pricing fields before probe gas estimation', async () => {
    const provider = new ProbeReaderProvider();
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    await reader.testProbeEstimateGas({
      gasLimit: BigNumber.from(100000),
      gasPrice: BigNumber.from(1),
      maxPriorityFeePerGas: BigNumber.from(2),
      maxFeePerGas: BigNumber.from(3),
    });

    expect(provider.lastEstimateGasTransaction?.gasLimit).to.be.undefined;
    expect(provider.lastEstimateGasTransaction?.gasPrice).to.be.undefined;
    expect(provider.lastEstimateGasTransaction?.maxPriorityFeePerGas).to.be
      .undefined;
    expect(provider.lastEstimateGasTransaction?.maxFeePerGas).to.be.undefined;
  });

  it('uses multicall for batched read calls when available', async () => {
    const provider = new BatchReaderProvider({ supportsMulticall: true });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testReadContractBatch();

    expect(result).to.deep.equal([TEST_ADDRESS, TEST_ADDRESS_2]);
    expect(provider.callTransactions).to.have.length(1);
    expect(provider.callTransactions[0].to).to.equal(MULTICALL3_ADDRESS);
  });

  it('falls back to individual calls when multicall is unavailable', async () => {
    const provider = new BatchReaderProvider({ supportsMulticall: false });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testReadContractBatch();

    expect(result).to.deep.equal([TEST_ADDRESS, TEST_ADDRESS_2]);
    expect(provider.callTransactions).to.have.length(2);
    expect(provider.callTransactions.map((tx) => tx.to)).to.deep.equal([
      TEST_ADDRESS,
      TEST_ADDRESS_2,
    ]);
  });

  it('falls back to individual calls when the multicall request fails', async () => {
    const provider = new BatchReaderProvider({
      supportsMulticall: true,
      multicallError: new Error('batch failed'),
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testReadContractBatch();

    expect(result).to.deep.equal([TEST_ADDRESS, TEST_ADDRESS_2]);
    expect(provider.callTransactions.map((tx) => tx.to)).to.deep.equal([
      MULTICALL3_ADDRESS,
      TEST_ADDRESS,
      TEST_ADDRESS_2,
    ]);
  });

  it('retries multicall support detection after transient getCode failures', async () => {
    const provider = new BatchReaderProvider({
      supportsMulticall: true,
      getCodeFailures: 1,
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    await reader.testReadContractBatch();
    await reader.testReadContractBatch();

    expect(provider.callTransactions.map((tx) => tx.to)).to.deep.equal([
      TEST_ADDRESS,
      TEST_ADDRESS_2,
      MULTICALL3_ADDRESS,
    ]);
  });

  it('shares safe multicall support promises across concurrent callers', async () => {
    const provider = new BatchReaderProvider({
      supportsMulticall: true,
      getCodeFailures: 1,
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const [firstResult, secondResult] = await Promise.all([
      reader.testReadContractBatch(),
      reader.testReadContractBatch(),
    ]);

    expect(firstResult).to.deep.equal([TEST_ADDRESS, TEST_ADDRESS_2]);
    expect(secondResult).to.deep.equal([TEST_ADDRESS, TEST_ADDRESS_2]);
    expect(provider.callTransactions.map((tx) => tx.to)).to.deep.equal([
      TEST_ADDRESS,
      TEST_ADDRESS_2,
      TEST_ADDRESS,
      TEST_ADDRESS_2,
    ]);
  });

  it('includes chain context when batched reads return failed subcalls', async () => {
    const provider = new BatchReaderProvider({
      supportsMulticall: true,
      multicallSecondFailure: true,
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    try {
      await reader.testReadContractBatch();
      expect.fail('Expected batched read to fail');
    } catch (error) {
      expect(String(error)).to.include(
        'Multicall read failed for owner on 0x0000000000000000000000000000000000000002 (chain: test1)',
      );
    }
  });

  it('uses multicall for batched probe calls when available', async () => {
    const provider = new BatchReaderProvider({ supportsMulticall: true });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testTryProbeContractBatch();

    expect(result).to.deep.equal([TEST_ADDRESS, TEST_ADDRESS_2]);
    expect(provider.callTransactions).to.have.length(1);
    expect(provider.callTransactions[0].to).to.equal(MULTICALL3_ADDRESS);
  });

  it('returns undefined when multicall probe batching is unavailable', async () => {
    const provider = new BatchReaderProvider({ supportsMulticall: false });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testTryProbeContractBatch();

    expect(result).to.be.undefined;
    expect(provider.callTransactions).to.have.length(0);
  });

  it('treats failed multicall probe subcalls as undefined', async () => {
    const provider = new BatchReaderProvider({
      supportsMulticall: true,
      multicallSecondFailure: true,
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testTryProbeContractBatch();

    expect(result).to.deep.equal([TEST_ADDRESS, undefined]);
    expect(provider.callTransactions).to.have.length(1);
    expect(provider.callTransactions[0].to).to.equal(MULTICALL3_ADDRESS);
  });

  it('returns undefined when batched probe wrappers return 0x', async () => {
    const provider = new BatchReaderProvider({
      supportsMulticall: true,
      multicallResult: '0x',
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testTryProbeContractBatch();

    expect(result).to.be.undefined;
    expect(provider.callTransactions).to.have.length(1);
    expect(provider.callTransactions[0].to).to.equal(MULTICALL3_ADDRESS);
  });

  it('returns undefined for batched probe decodes that hit BUFFER_OVERRUN', async () => {
    const provider = new BatchReaderProvider({
      supportsMulticall: true,
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);
    const interfaceWithBufferOverrun = Object.assign(
      Object.create(TEST_INTERFACE),
      {
        decodeFunctionResult: () => {
          throw Object.assign(new Error('data out-of-bounds'), {
            code: EthersError.BUFFER_OVERRUN,
          });
        },
      },
    ) as utils.Interface;

    const result = await reader.testTryProbeContractBatchWithInterface(
      interfaceWithBufferOverrun,
    );

    expect(result).to.deep.equal([undefined, TEST_ADDRESS_2]);
  });

  it('uses batchContractAddress from chain metadata for batched probe calls', async () => {
    multiProvider = multiProvider.extendChainMetadata({
      [TestChainName.test1]: {
        batchContractAddress: CUSTOM_BATCH_CONTRACT_ADDRESS,
      },
    });
    const provider = new BatchReaderProvider({
      supportsMulticall: true,
      batchContractAddress: CUSTOM_BATCH_CONTRACT_ADDRESS,
    });
    multiProvider.setProvider(TestChainName.test1, provider);
    const reader = new ReaderHarness(multiProvider, TestChainName.test1);

    const result = await reader.testTryProbeContractBatch();

    expect(result).to.deep.equal([TEST_ADDRESS, TEST_ADDRESS_2]);
    expect(provider.callTransactions).to.have.length(1);
    expect(provider.callTransactions[0].to).to.equal(
      CUSTOM_BATCH_CONTRACT_ADDRESS,
    );
  });
});
