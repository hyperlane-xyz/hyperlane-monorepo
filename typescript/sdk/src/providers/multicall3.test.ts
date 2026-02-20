import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import sinon from 'sinon';

import type { MultiProvider } from './MultiProvider.js';
import type { EvmReadCall } from './multicall3.js';
import {
  buildGetEthBalanceCall,
  clearMulticall3BatchSupportCache,
  readEvmCallMapWithMulticall,
  readEvmCallsWithMulticall,
} from './multicall3.js';

const MULTICALL3_IFACE = new utils.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
]);
const ERC20_IFACE = new utils.Interface([
  'function balanceOf(address account) view returns (uint256)',
]);
const TEST_CHAIN = 'test1';
const TEST_TOKEN = '0x00000000000000000000000000000000000000AA';
const TEST_WALLET = '0x00000000000000000000000000000000000000BB';
type MinimalMultiProvider = Pick<
  MultiProvider,
  'getProvider' | 'getChainName' | 'tryGetEvmBatchContractAddress'
>;

function encodeAggregate3Result(
  results: Array<{ success: boolean; returnData: string }>,
): string {
  return MULTICALL3_IFACE.encodeFunctionResult('aggregate3', [results]);
}

function createReadCall(overrides: Partial<EvmReadCall> = {}): EvmReadCall {
  return {
    contract: { address: TEST_TOKEN, interface: ERC20_IFACE },
    functionName: 'balanceOf',
    args: [TEST_WALLET],
    ...overrides,
  };
}

function createMockMultiProvider(
  provider: providers.Provider,
  batchContractAddress?: string | null,
): MultiProvider {
  const mock: MinimalMultiProvider = {
    getProvider: sinon.stub().returns(provider),
    getChainName: sinon.stub().returns(TEST_CHAIN),
    tryGetEvmBatchContractAddress: sinon
      .stub()
      .returns(batchContractAddress ?? null),
  };
  return mock as unknown as MultiProvider;
}

describe('readEvmCallsWithMulticall', () => {
  beforeEach(() => {
    clearMulticall3BatchSupportCache();
  });

  it('returns decoded results when multicall succeeds', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000CC';
    const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(42),
    ]);

    const provider = {
      getCode: sinon.stub().resolves('0x1234'),
      call: sinon.stub().resolves(
        encodeAggregate3Result([
          {
            success: true,
            returnData: encodedBalance,
          },
        ]),
      ),
    } as unknown as providers.Provider;

    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );
    const [result] = await readEvmCallsWithMulticall(
      multiProvider,
      TEST_CHAIN,
      [createReadCall()],
    );

    expect((result as BigNumber).toString()).to.equal('42');
    expect(
      (provider.getCode as sinon.SinonStub).calledOnceWith(
        batchContractAddress,
      ),
    ).to.be.true;
    expect((provider.call as sinon.SinonStub).calledOnce).to.be.true;
  });

  it('returns keyed results with readEvmCallMapWithMulticall', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000C0';
    const encoded42 = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(42),
    ]);
    const encoded9 = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(9),
    ]);
    const provider = {
      getCode: sinon.stub().resolves('0x1234'),
      call: sinon.stub().resolves(
        encodeAggregate3Result([
          { success: true, returnData: encoded42 },
          { success: true, returnData: encoded9 },
        ]),
      ),
    } as unknown as providers.Provider;
    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );

    const result = await readEvmCallMapWithMulticall(
      multiProvider,
      TEST_CHAIN,
      {
        balance: createReadCall({
          transform: (value) => value as BigNumber,
        }) as EvmReadCall<BigNumber>,
        doubled: createReadCall({
          transform: (value) => (value as BigNumber).mul(2),
        }) as EvmReadCall<BigNumber>,
      },
    );

    expect(result.balance.toString()).to.equal('42');
    expect(result.doubled.toString()).to.equal('18');
  });

  it('falls back to direct call for failed non-allowFailure result', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000CD';
    const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(99),
    ]);

    const provider = {
      getCode: sinon.stub().resolves('0x1234'),
      call: sinon
        .stub()
        .onFirstCall()
        .resolves(
          encodeAggregate3Result([
            {
              success: false,
              returnData: '0x',
            },
          ]),
        )
        .onSecondCall()
        .resolves(encodedBalance),
    } as unknown as providers.Provider;

    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );
    const [result] = await readEvmCallsWithMulticall(
      multiProvider,
      TEST_CHAIN,
      [createReadCall({ allowFailure: false })],
    );

    expect((result as BigNumber).toString()).to.equal('99');
    expect((provider.call as sinon.SinonStub).callCount).to.equal(2);
  });

  it('returns null for failed allowFailure result without direct retry', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000CE';
    const provider = {
      getCode: sinon.stub().resolves('0x1234'),
      call: sinon.stub().resolves(
        encodeAggregate3Result([
          {
            success: false,
            returnData: '0x',
          },
        ]),
      ),
    } as unknown as providers.Provider;

    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );
    const [result] = await readEvmCallsWithMulticall(
      multiProvider,
      TEST_CHAIN,
      [createReadCall({ allowFailure: true })],
    );

    expect(result).to.equal(null);
    expect((provider.call as sinon.SinonStub).calledOnce).to.be.true;
  });

  it('uses direct reads when forced via options', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000CF';
    const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(7),
    ]);
    const provider = {
      getCode: sinon.stub().resolves('0x1234'),
      call: sinon.stub().resolves(encodedBalance),
    } as unknown as providers.Provider;

    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );
    const [result] = await readEvmCallsWithMulticall(
      multiProvider,
      TEST_CHAIN,
      [createReadCall()],
      { forceDirectReads: true },
    );

    expect((result as BigNumber).toString()).to.equal('7');
    expect((provider.getCode as sinon.SinonStub).notCalled).to.be.true;
    expect((provider.call as sinon.SinonStub).calledOnce).to.be.true;
  });

  it('uses direct reads when multicall contract is unavailable', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000D0';
    const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(11),
    ]);
    const provider = {
      getCode: sinon.stub().resolves('0x'),
      call: sinon.stub().resolves(encodedBalance),
    } as unknown as providers.Provider;

    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );
    const [result] = await readEvmCallsWithMulticall(
      multiProvider,
      TEST_CHAIN,
      [createReadCall()],
    );

    expect((result as BigNumber).toString()).to.equal('11');
    expect((provider.getCode as sinon.SinonStub).calledOnce).to.be.true;
    expect((provider.call as sinon.SinonStub).calledOnce).to.be.true;
  });

  it('retries direct read when multicall decode fails', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000D1';
    const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(22),
    ]);
    const provider = {
      getCode: sinon.stub().resolves('0x1234'),
      call: sinon
        .stub()
        .onFirstCall()
        .resolves(
          encodeAggregate3Result([
            {
              success: true,
              returnData: '0x1234',
            },
          ]),
        )
        .onSecondCall()
        .resolves(encodedBalance),
    } as unknown as providers.Provider;

    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );
    const [result] = await readEvmCallsWithMulticall(
      multiProvider,
      TEST_CHAIN,
      [createReadCall()],
    );

    expect((result as BigNumber).toString()).to.equal('22');
    expect((provider.call as sinon.SinonStub).callCount).to.equal(2);
  });

  it('returns empty array for empty call list', async () => {
    const provider = {
      getCode: sinon.stub(),
      call: sinon.stub(),
    } as unknown as providers.Provider;
    const multiProvider = createMockMultiProvider(provider, null);
    const getProviderStub = multiProvider.getProvider as sinon.SinonStub;

    const result = await readEvmCallsWithMulticall(
      multiProvider,
      TEST_CHAIN,
      [],
    );

    expect(result).to.deep.equal([]);
    expect(getProviderStub.notCalled).to.be.true;
  });

  it('caches positive multicall availability checks', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000D2';
    const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(33),
    ]);
    const provider = {
      getCode: sinon.stub().resolves('0x1234'),
      call: sinon.stub().resolves(
        encodeAggregate3Result([
          {
            success: true,
            returnData: encodedBalance,
          },
        ]),
      ),
    } as unknown as providers.Provider;
    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );

    await readEvmCallsWithMulticall(multiProvider, TEST_CHAIN, [
      createReadCall(),
    ]);
    await readEvmCallsWithMulticall(multiProvider, TEST_CHAIN, [
      createReadCall(),
    ]);

    expect((provider.getCode as sinon.SinonStub).calledOnce).to.be.true;
  });

  it('does not cache unavailable multicall checks', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000D3';
    const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(44),
    ]);
    const provider = {
      getCode: sinon.stub().resolves('0x'),
      call: sinon.stub().resolves(encodedBalance),
    } as unknown as providers.Provider;
    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );

    await readEvmCallsWithMulticall(multiProvider, TEST_CHAIN, [
      createReadCall(),
    ]);
    await readEvmCallsWithMulticall(multiProvider, TEST_CHAIN, [
      createReadCall(),
    ]);

    expect((provider.getCode as sinon.SinonStub).callCount).to.equal(2);
  });

  it('does not cache probe failures as unavailable', async () => {
    const batchContractAddress = '0x00000000000000000000000000000000000000D4';
    const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(55),
    ]);
    const provider = {
      getCode: sinon.stub().rejects(new Error('rpc timeout')),
      call: sinon.stub().resolves(encodedBalance),
    } as unknown as providers.Provider;
    const multiProvider = createMockMultiProvider(
      provider,
      batchContractAddress,
    );

    await readEvmCallsWithMulticall(multiProvider, TEST_CHAIN, [
      createReadCall(),
    ]);
    await readEvmCallsWithMulticall(multiProvider, TEST_CHAIN, [
      createReadCall(),
    ]);

    expect((provider.getCode as sinon.SinonStub).callCount).to.equal(2);
    expect((provider.call as sinon.SinonStub).callCount).to.equal(2);
  });
});

describe('buildGetEthBalanceCall', () => {
  const MULTICALL3_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const TARGET_ADDR = '0x00000000000000000000000000000000000000EE';

  it('returns an EvmReadCall targeting the multicall3 contract itself', () => {
    const call = buildGetEthBalanceCall(MULTICALL3_ADDR, TARGET_ADDR);
    expect(call.contract.address).to.equal(MULTICALL3_ADDR);
    expect(call.functionName).to.equal('getEthBalance');
    expect(call.args).to.deep.equal([TARGET_ADDR]);
  });

  it('encodes calldata for getEthBalance correctly', () => {
    const call = buildGetEthBalanceCall(MULTICALL3_ADDR, TARGET_ADDR);
    const encoded = call.contract.interface.encodeFunctionData(
      call.functionName,
      call.args ? [...call.args] : [],
    );
    expect(encoded).to.be.a('string');
    expect(encoded.startsWith('0x')).to.be.true;
    // getEthBalance(address) selector = 0x4d2301cc
    expect(encoded.slice(0, 10)).to.equal('0x4d2301cc');
  });

  it('can decode a uint256 result from getEthBalance', () => {
    const call = buildGetEthBalanceCall(MULTICALL3_ADDR, TARGET_ADDR);
    const encodedResult = call.contract.interface.encodeFunctionResult(
      'getEthBalance',
      [BigNumber.from('1000000000000000000')],
    );
    const decoded = call.contract.interface.decodeFunctionResult(
      'getEthBalance',
      encodedResult,
    );
    expect(decoded[0].toString()).to.equal('1000000000000000000');
  });
});
