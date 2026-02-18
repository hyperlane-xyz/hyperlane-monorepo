import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { clearMulticall3BatchSupportCache } from '../providers/multicall3.js';
import { Token } from '../token/Token.js';
import { TokenAmount } from '../token/TokenAmount.js';
import { TokenStandard } from '../token/TokenStandard.js';

import { WarpCore } from './WarpCore.js';

const MULTICALL3_IFACE = new utils.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
]);
const ERC20_IFACE = new utils.Interface([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const LOCKBOX_IFACE = new utils.Interface([
  'function lockbox() view returns (address)',
  'function wrappedToken() view returns (address)',
]);

const TEST_CHAIN = 'test1';
const TEST_WALLET = '0x00000000000000000000000000000000000000BB';
const BATCH_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11';

function encodeAggregate3Result(
  results: Array<{ success: boolean; returnData: string }>,
): string {
  return MULTICALL3_IFACE.encodeFunctionResult('aggregate3', [results]);
}

function makeToken(
  standard: TokenStandard,
  addressOrDenom: string,
  chain = TEST_CHAIN,
): Token {
  return new Token({
    chainName: chain,
    standard,
    addressOrDenom,
    decimals: 18,
    symbol: 'TST',
    name: 'Test',
  });
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

function createWarpCoreWithMocks(
  mp: any,
  tokens: Token[],
): { warpCore: WarpCore; mpp: MultiProtocolProvider } {
  const mpp = {
    toMultiProvider: sinon.stub().returns(mp),
    tryGetChainMetadata: sinon
      .stub()
      .returns({ protocol: ProtocolType.Ethereum }),
    getChainMetadata: sinon.stub().returns({
      protocol: ProtocolType.Ethereum,
      name: TEST_CHAIN,
      nativeToken: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    }),
    getChainName: sinon.stub().returns(TEST_CHAIN),
  } as unknown as MultiProtocolProvider;
  const warpCore = new WarpCore(mpp, tokens);
  return { warpCore, mpp };
}

describe('WarpCore batch methods', () => {
  const sandbox = sinon.createSandbox();

  beforeEach(() => {
    clearMulticall3BatchSupportCache();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getBalances', () => {
    it('returns empty array for empty token list', async () => {
      const mpp = {} as MultiProtocolProvider;
      const warpCore = new WarpCore(mpp, []);
      const result = await warpCore.getBalances([], TEST_WALLET);
      expect(result).to.deep.equal([]);
    });

    it('delegates to getTokenBalancesBatch', async () => {
      const token = makeToken(
        TokenStandard.ERC20,
        '0x00000000000000000000000000000000000000A1',
      );

      const encoded = ERC20_IFACE.encodeFunctionResult('balanceOf', [
        BigNumber.from(100),
      ]);
      const callStub = sinon
        .stub()
        .resolves(
          encodeAggregate3Result([{ success: true, returnData: encoded }]),
        );
      const provider = createMockProvider(callStub);
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBalances([token], TEST_WALLET);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.be.instanceOf(TokenAmount);
      expect(results[0]!.amount).to.equal(100n);
    });

    it('batches multiple tokens per chain', async () => {
      const token1 = makeToken(
        TokenStandard.ERC20,
        '0x00000000000000000000000000000000000000A1',
      );
      const token2 = makeToken(
        TokenStandard.ERC20,
        '0x00000000000000000000000000000000000000A2',
      );

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
      const { warpCore } = createWarpCoreWithMocks(mp, [token1, token2]);

      const results = await warpCore.getBalances([token1, token2], TEST_WALLET);

      expect(results).to.have.lengthOf(2);
      expect(results[0]!.amount).to.equal(100n);
      expect(results[1]!.amount).to.equal(200n);
    });
  });

  describe('getBridgedSupplies', () => {
    it('returns empty array for empty token list', async () => {
      const mpp = {} as MultiProtocolProvider;
      const warpCore = new WarpCore(mpp, []);
      const result = await warpCore.getBridgedSupplies([]);
      expect(result).to.deep.equal([]);
    });

    it('handles synthetic tokens (totalSupply)', async () => {
      const token = makeToken(
        TokenStandard.EvmHypSynthetic,
        '0x00000000000000000000000000000000000000A1',
      );

      const encoded = ERC20_IFACE.encodeFunctionResult('totalSupply', [
        BigNumber.from(1000),
      ]);
      const callStub = sinon
        .stub()
        .resolves(
          encodeAggregate3Result([{ success: true, returnData: encoded }]),
        );
      const provider = createMockProvider(callStub);
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBridgedSupplies([token]);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.equal(1000n);
    });

    it('handles native tokens (getEthBalance)', async () => {
      const token = makeToken(
        TokenStandard.EvmHypNative,
        '0x00000000000000000000000000000000000000A1',
      );

      const multicall3Iface = new utils.Interface([
        'function getEthBalance(address) view returns (uint256)',
      ]);
      const encoded = multicall3Iface.encodeFunctionResult('getEthBalance', [
        BigNumber.from(5000),
      ]);
      const callStub = sinon
        .stub()
        .resolves(
          encodeAggregate3Result([{ success: true, returnData: encoded }]),
        );
      const provider = createMockProvider(callStub);
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBridgedSupplies([token]);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.equal(5000n);
    });

    it('handles collateral tokens (two-phase: wrappedToken then balanceOf)', async () => {
      const tokenAddr = '0x00000000000000000000000000000000000000A1';
      const wrappedAddr = '0x00000000000000000000000000000000000000B1';
      const token = makeToken(TokenStandard.EvmHypCollateral, tokenAddr);

      // Phase 1: wrappedToken() resolves to wrappedAddr
      const encodedWrapped = LOCKBOX_IFACE.encodeFunctionResult(
        'wrappedToken',
        [wrappedAddr],
      );
      // Phase 2: balanceOf(tokenAddr) on wrappedAddr
      const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
        BigNumber.from(7500),
      ]);

      let callCount = 0;
      const callStub = sinon.stub().callsFake(() => {
        callCount++;
        if (callCount === 1) {
          // Phase 1: getCode check
          return Promise.resolve('0x1234');
        }
        if (callCount === 2) {
          // Phase 1 multicall: wrappedToken()
          return Promise.resolve(
            encodeAggregate3Result([
              { success: true, returnData: encodedWrapped },
            ]),
          );
        }
        // Phase 2 multicall: balanceOf()
        return Promise.resolve(
          encodeAggregate3Result([
            { success: true, returnData: encodedBalance },
          ]),
        );
      });

      const provider = {
        getCode: sinon.stub().resolves('0x1234'),
        call: callStub,
      } as unknown as providers.Provider;
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBridgedSupplies([token]);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.equal(7500n);
    });

    it('handles lockbox tokens (two-phase: lockbox+wrappedToken then balanceOf)', async () => {
      const tokenAddr = '0x00000000000000000000000000000000000000A1';
      const lockboxAddr = '0x00000000000000000000000000000000000000C1';
      const wrappedAddr = '0x00000000000000000000000000000000000000B1';
      const token = makeToken(TokenStandard.EvmHypXERC20Lockbox, tokenAddr);

      // Phase 1: lockbox() and wrappedToken()
      const encodedLockbox = LOCKBOX_IFACE.encodeFunctionResult('lockbox', [
        lockboxAddr,
      ]);
      const encodedWrapped = LOCKBOX_IFACE.encodeFunctionResult(
        'wrappedToken',
        [wrappedAddr],
      );
      // Phase 2: balanceOf(lockboxAddr) on wrappedAddr
      const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
        BigNumber.from(9999),
      ]);

      let callCount = 0;
      const callStub = sinon.stub().callsFake(() => {
        callCount++;
        if (callCount === 1) {
          // Phase 1 multicall: lockbox() + wrappedToken()
          return Promise.resolve(
            encodeAggregate3Result([
              { success: true, returnData: encodedLockbox },
              { success: true, returnData: encodedWrapped },
            ]),
          );
        }
        // Phase 2 multicall: balanceOf(lockbox) on wrappedToken
        return Promise.resolve(
          encodeAggregate3Result([
            { success: true, returnData: encodedBalance },
          ]),
        );
      });

      const provider = {
        getCode: sinon.stub().resolves('0x1234'),
        call: callStub,
      } as unknown as providers.Provider;
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBridgedSupplies([token]);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.equal(9999n);
    });

    it('falls back to adapter for non-EVM tokens', async () => {
      const token = makeToken(
        TokenStandard.CwHypSynthetic,
        'wasm1abc',
        TEST_CHAIN,
      );

      // Stub getAdapter to return a mock adapter
      const adapterStub = {
        getBridgedSupply: sinon.stub().resolves(BigInt(4242)),
      };
      sandbox.stub(token, 'getAdapter').returns(adapterStub as any);

      const callStub = sinon.stub();
      const provider = createMockProvider(callStub);
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBridgedSupplies([token]);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.equal(4242n);
    });

    it('falls back to adapter for complex EVM standards', async () => {
      const token = makeToken(
        TokenStandard.EvmHypSyntheticRebase,
        '0x00000000000000000000000000000000000000A1',
      );

      const adapterStub = {
        getBridgedSupply: sinon.stub().resolves(BigInt(3333)),
      };
      sandbox.stub(token, 'getAdapter').returns(adapterStub as any);

      const callStub = sinon.stub();
      const provider = createMockProvider(callStub);
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBridgedSupplies([token]);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.equal(3333n);
    });

    it('handles xERC20 standards via wrappedToken + balanceOf', async () => {
      const tokenAddr = '0x00000000000000000000000000000000000000A1';
      const wrappedAddr = '0x00000000000000000000000000000000000000B1';
      const token = makeToken(TokenStandard.EvmHypXERC20, tokenAddr);

      const encodedWrapped = LOCKBOX_IFACE.encodeFunctionResult(
        'wrappedToken',
        [wrappedAddr],
      );
      const encodedBalance = ERC20_IFACE.encodeFunctionResult('balanceOf', [
        BigNumber.from(4444),
      ]);
      const callStub = sinon
        .stub()
        .onFirstCall()
        .resolves(
          encodeAggregate3Result([
            { success: true, returnData: encodedWrapped },
          ]),
        )
        .onSecondCall()
        .resolves(
          encodeAggregate3Result([
            { success: true, returnData: encodedBalance },
          ]),
        );
      const provider = createMockProvider(callStub);
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBridgedSupplies([token]);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.equal(4444n);
    });

    it('returns null for failed reads', async () => {
      const token = makeToken(
        TokenStandard.EvmHypSynthetic,
        '0x00000000000000000000000000000000000000A1',
      );

      const callStub = sinon
        .stub()
        .resolves(
          encodeAggregate3Result([{ success: false, returnData: '0x' }]),
        );
      const provider = createMockProvider(callStub);
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [token]);

      const results = await warpCore.getBridgedSupplies([token]);

      expect(results).to.have.lengthOf(1);
      expect(results[0]).to.equal(null);
    });

    it('handles mixed token standards in a single batch', async () => {
      const syntheticToken = makeToken(
        TokenStandard.EvmHypSynthetic,
        '0x00000000000000000000000000000000000000A1',
      );
      const nativeToken = makeToken(
        TokenStandard.EvmHypNative,
        '0x00000000000000000000000000000000000000A2',
      );

      const encodedSupply = ERC20_IFACE.encodeFunctionResult('totalSupply', [
        BigNumber.from(1000),
      ]);
      const multicall3Iface = new utils.Interface([
        'function getEthBalance(address) view returns (uint256)',
      ]);
      const encodedNative = multicall3Iface.encodeFunctionResult(
        'getEthBalance',
        [BigNumber.from(2000)],
      );

      const callStub = sinon.stub().resolves(
        encodeAggregate3Result([
          { success: true, returnData: encodedSupply },
          { success: true, returnData: encodedNative },
        ]),
      );
      const provider = createMockProvider(callStub);
      const mp = createMockMultiProvider(provider);
      const { warpCore } = createWarpCoreWithMocks(mp, [
        syntheticToken,
        nativeToken,
      ]);

      const results = await warpCore.getBridgedSupplies([
        syntheticToken,
        nativeToken,
      ]);

      expect(results).to.have.lengthOf(2);
      expect(results[0]).to.equal(1000n);
      expect(results[1]).to.equal(2000n);
    });
  });
});
