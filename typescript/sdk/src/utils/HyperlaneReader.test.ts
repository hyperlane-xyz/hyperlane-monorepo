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
const TEST_INTERFACE = new utils.Interface([
  'function probe() view returns (address)',
  'function owner() view returns (address)',
]);
const MULTICALL3_INTERFACE = new utils.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
]);

class ReaderHarness extends HyperlaneReader {
  async testProbeContractCall(): Promise<string | undefined> {
    return this.probeContractCall<string>(
      TEST_ADDRESS,
      TEST_INTERFACE,
      'probe',
    );
  }

  async testProbeEstimateGas(): Promise<BigNumber | undefined> {
    return this.probeContractEstimateGas({
      to: TEST_ADDRESS,
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
}

class ProbeReaderProvider extends providers.BaseProvider {
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
    _transaction: providers.TransactionRequest,
    _blockTag?: providers.BlockTag,
  ): Promise<string> {
    if (this.options.callError) {
      throw this.options.callError;
    }

    return this.options.callResult ?? '0x';
  }

  async estimateGas(
    _transaction: providers.TransactionRequest,
  ): Promise<BigNumber> {
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

  constructor(
    private readonly options: {
      supportsMulticall?: boolean;
      multicallError?: Error;
      multicallSecondFailure?: boolean;
    } = {},
  ) {
    super({ name: 'test', chainId: 1 });
  }

  async getCode(address: string): Promise<string> {
    return address.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase() &&
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
      transaction.to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()
    ) {
      if (this.options.multicallError) {
        throw this.options.multicallError;
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
});
