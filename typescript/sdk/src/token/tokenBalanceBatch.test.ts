import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { clearMulticall3BatchSupportCache } from '../providers/multicall3.js';

import type { IToken } from './IToken.js';
import { TokenAmount } from './TokenAmount.js';
import { TokenStandard } from './TokenStandard.js';
import { getTokenBalancesBatch } from './tokenBalanceBatch.js';

const MULTICALL3_IFACE = new utils.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
]);
const ERC20_IFACE = new utils.Interface([
  'function balanceOf(address account) view returns (uint256)',
]);

const TEST_CHAIN = 'test1';
const TEST_CHAIN2 = 'test2';
const TEST_WALLET = '0x00000000000000000000000000000000000000BB';
const BATCH_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11';

function encodeAggregate3Result(
  results: Array<{ success: boolean; returnData: string }>,
): string {
  return MULTICALL3_IFACE.encodeFunctionResult('aggregate3', [results]);
}

function makeToken(
  overrides: Partial<IToken> & { chainName: string; standard: TokenStandard },
): IToken {
  return {
    protocol:
      overrides.protocol ?? (ProtocolType.Ethereum as ProtocolType.Ethereum),
    addressOrDenom:
      overrides.addressOrDenom ?? '0x0000000000000000000000000000000000000001',
    decimals: overrides.decimals ?? 18,
    symbol: overrides.symbol ?? 'TST',
    name: overrides.name ?? 'Test Token',
    chainName: overrides.chainName,
    standard: overrides.standard,
    isNative: overrides.isNative ?? (() => false),
    isNft: overrides.isNft ?? (() => false),
    isHypNative: overrides.isHypNative ?? (() => false),
    isHypToken: overrides.isHypToken ?? (() => false),
    isIbcToken: overrides.isIbcToken ?? (() => false),
    isMultiChainToken: overrides.isMultiChainToken ?? (() => false),
    getConnections: overrides.getConnections ?? (() => []),
    getConnectionForChain: overrides.getConnectionForChain ?? (() => undefined),
    addConnection: overrides.addConnection ?? (() => ({}) as IToken),
    removeConnection: overrides.removeConnection ?? (() => ({}) as IToken),
    equals: overrides.equals ?? (() => false),
    isFungibleWith: overrides.isFungibleWith ?? (() => false),
    getAdapter: overrides.getAdapter ?? (() => ({}) as any),
    getHypAdapter: overrides.getHypAdapter ?? (() => ({}) as any),
    getBalance:
      overrides.getBalance ??
      (() => Promise.resolve(new TokenAmount(0, {} as IToken))),
    amount: overrides.amount ?? ((n) => new TokenAmount(n, {} as IToken)),
  } as IToken;
}

function createMockProvider(callStub: sinon.SinonStub): providers.Provider {
  return {
    getCode: sinon.stub().resolves('0x1234'),
    call: callStub,
  } as unknown as providers.Provider;
}

function createMockMultiProvider(
  provider: providers.Provider,
  batchAddr: string | null = BATCH_ADDR,
): any {
  return {
    getProvider: sinon.stub().returns(provider),
    getChainName: sinon.stub().returns(TEST_CHAIN),
    tryGetEvmBatchContractAddress: sinon.stub().returns(batchAddr),
    multicall: sinon
      .stub()
      .callsFake(async (_chain: string, calls: any[], _opts?: any) => {
        // Delegate to the real readEvmCallsWithMulticall using the mock provider
        const { readEvmCallsWithMulticall } =
          await import('../providers/multicall3.js');
        return readEvmCallsWithMulticall(
          {
            getProvider: () => provider,
            getChainName: () => TEST_CHAIN,
            tryGetEvmBatchContractAddress: () => batchAddr,
          } as any,
          TEST_CHAIN,
          calls,
          _opts,
        );
      }),
  };
}

function createMockMultiProtocolProvider(
  multiProvider: any,
): MultiProtocolProvider {
  return {
    toMultiProvider: sinon.stub().returns(multiProvider),
  } as unknown as MultiProtocolProvider;
}

describe('getTokenBalancesBatch', () => {
  beforeEach(() => {
    clearMulticall3BatchSupportCache();
  });

  it('returns empty array for empty token list', async () => {
    const mpp = {} as MultiProtocolProvider;
    const result = await getTokenBalancesBatch([], mpp, TEST_WALLET);
    expect(result).to.deep.equal([]);
  });

  it('batches EVM ERC20 tokens via multicall', async () => {
    const token1 = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.ERC20,
      addressOrDenom: '0x00000000000000000000000000000000000000A1',
    });
    const token2 = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.ERC20,
      addressOrDenom: '0x00000000000000000000000000000000000000A2',
    });

    const encoded1 = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(100),
    ]);
    const encoded2 = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(200),
    ]);
    const callStub = sinon.stub().resolves(
      encodeAggregate3Result([
        { success: true, returnData: encoded1 },
        { success: true, returnData: encoded2 },
      ]),
    );
    const provider = createMockProvider(callStub);
    const mp = createMockMultiProvider(provider);
    const mpp = createMockMultiProtocolProvider(mp);

    const results = await getTokenBalancesBatch(
      [token1, token2],
      mpp,
      TEST_WALLET,
    );

    expect(results).to.have.lengthOf(2);
    expect(results[0]).to.be.instanceOf(TokenAmount);
    expect(results[0]!.amount).to.equal(100n);
    expect(results[1]!.amount).to.equal(200n);
  });

  it('handles EVM native token via getEthBalance', async () => {
    const nativeToken = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.EvmNative,
      addressOrDenom: '',
      isNative: () => true,
    });
    const erc20Token = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.ERC20,
      addressOrDenom: '0x00000000000000000000000000000000000000A1',
    });

    // getEthBalance returns uint256, balanceOf returns uint256
    const multicall3Iface = new utils.Interface([
      'function getEthBalance(address) view returns (uint256)',
    ]);
    const encodedNative = multicall3Iface.encodeFunctionResult(
      'getEthBalance',
      [BigNumber.from(500)],
    );
    const encodedErc20 = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(300),
    ]);

    const callStub = sinon.stub().resolves(
      encodeAggregate3Result([
        { success: true, returnData: encodedNative },
        { success: true, returnData: encodedErc20 },
      ]),
    );
    const provider = createMockProvider(callStub);
    const mp = createMockMultiProvider(provider);
    const mpp = createMockMultiProtocolProvider(mp);

    const results = await getTokenBalancesBatch(
      [nativeToken, erc20Token],
      mpp,
      TEST_WALLET,
    );

    expect(results).to.have.lengthOf(2);
    expect(results[0]!.amount).to.equal(500n);
    expect(results[1]!.amount).to.equal(300n);
  });

  it('falls back to adapter for non-EVM tokens', async () => {
    const cosmosToken = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.CosmosNative,
      protocol: ProtocolType.Cosmos,
      addressOrDenom: 'uatom',
      getBalance: sinon.stub().resolves(new TokenAmount(999, {} as IToken)),
    });

    const mpp = {
      toMultiProvider: sinon.stub().returns({
        getProvider: sinon.stub(),
        getChainName: sinon.stub().returns(TEST_CHAIN),
        tryGetEvmBatchContractAddress: sinon.stub().returns(null),
        multicall: sinon.stub(),
      }),
    } as unknown as MultiProtocolProvider;

    const results = await getTokenBalancesBatch(
      [cosmosToken],
      mpp,
      TEST_WALLET,
    );

    expect(results).to.have.lengthOf(1);
    expect(results[0]!.amount).to.equal(999n);
  });

  it('handles mixed EVM and non-EVM tokens', async () => {
    const evmToken = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.ERC20,
      addressOrDenom: '0x00000000000000000000000000000000000000A1',
    });
    const cosmosToken = makeToken({
      chainName: TEST_CHAIN2,
      standard: TokenStandard.CosmosNative,
      protocol: ProtocolType.Cosmos,
      addressOrDenom: 'uatom',
      getBalance: sinon.stub().resolves(new TokenAmount(777, {} as IToken)),
    });

    const encodedErc20 = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(42),
    ]);
    const callStub = sinon
      .stub()
      .resolves(
        encodeAggregate3Result([{ success: true, returnData: encodedErc20 }]),
      );
    const provider = createMockProvider(callStub);
    const mp = createMockMultiProvider(provider);
    const mpp = createMockMultiProtocolProvider(mp);

    const results = await getTokenBalancesBatch(
      [evmToken, cosmosToken],
      mpp,
      TEST_WALLET,
    );

    expect(results).to.have.lengthOf(2);
    expect(results[0]!.amount).to.equal(42n);
    expect(results[1]!.amount).to.equal(777n);
  });

  it('returns null for failed multicall reads', async () => {
    const token1 = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.ERC20,
      addressOrDenom: '0x00000000000000000000000000000000000000A1',
    });
    const token2 = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.ERC20,
      addressOrDenom: '0x00000000000000000000000000000000000000A2',
    });

    const encodedOk = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(50),
    ]);

    const callStub = sinon.stub().resolves(
      encodeAggregate3Result([
        { success: true, returnData: encodedOk },
        { success: false, returnData: '0x' },
      ]),
    );
    const provider = createMockProvider(callStub);
    const mp = createMockMultiProvider(provider);
    const mpp = createMockMultiProtocolProvider(mp);

    const results = await getTokenBalancesBatch(
      [token1, token2],
      mpp,
      TEST_WALLET,
    );

    expect(results).to.have.lengthOf(2);
    expect(results[0]!.amount).to.equal(50n);
    expect(results[1]).to.equal(null);
  });

  it('handles single token', async () => {
    const token = makeToken({
      chainName: TEST_CHAIN,
      standard: TokenStandard.ERC20,
      addressOrDenom: '0x00000000000000000000000000000000000000A1',
    });

    const encoded = ERC20_IFACE.encodeFunctionResult('balanceOf', [
      BigNumber.from(123),
    ]);
    const callStub = sinon
      .stub()
      .resolves(
        encodeAggregate3Result([{ success: true, returnData: encoded }]),
      );
    const provider = createMockProvider(callStub);
    const mp = createMockMultiProvider(provider);
    const mpp = createMockMultiProtocolProvider(mp);

    const results = await getTokenBalancesBatch([token], mpp, TEST_WALLET);

    expect(results).to.have.lengthOf(1);
    expect(results[0]!.amount).to.equal(123n);
  });
});
