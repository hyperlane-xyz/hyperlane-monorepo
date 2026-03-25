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
const TEST_INTERFACE = new utils.Interface([
  'function probe() view returns (address)',
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
}

class ProbeReaderProvider extends providers.BaseProvider {
  constructor(
    private readonly options: {
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

    return '0x';
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
});
