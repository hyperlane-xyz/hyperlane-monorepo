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
const TEST_INTERFACE = new utils.Interface([
  'function probe() view returns (address)',
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

  async testProbeEstimateGas(
    overrides: providers.TransactionRequest = {},
  ): Promise<BigNumber | undefined> {
    return this.probeContractEstimateGas({
      to: TEST_ADDRESS,
      ...overrides,
    });
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
});
