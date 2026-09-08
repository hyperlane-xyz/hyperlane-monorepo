import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { ChainName, MultiProvider, Token } from '@hyperlane-xyz/sdk';
import { TokenStandard } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  calculateTransferCosts,
  estimateTransferRemoteGas,
} from './gasEstimation.js';

const testLogger = pino({ level: 'silent' });

describe('calculateTransferCosts — Tron vs Sealevel protocol path', () => {
  afterEach(() => {
    Sinon.restore();
  });

  function createMockDeps(protocol: ProtocolType) {
    const mockAdapter = {
      quoteTransferRemoteGas: Sinon.stub().resolves({
        igpQuote: { amount: 1000n },
        tokenFeeQuote: { amount: 0n, addressOrDenom: '' },
      }),
      populateTransferRemoteTx: Sinon.stub().resolves({
        to: '0xRouter',
        data: '0x',
        value: 1000n,
      }),
    };

    const mockToken = {
      standard: TokenStandard.EvmHypNative, // Native so we reach the isEVMLike check
      getHypAdapter: Sinon.stub().returns(mockAdapter),
    } as unknown as Token;

    const mockProvider = {
      estimateGas: Sinon.stub().resolves(BigNumber.from(200000)),
      getFeeData: Sinon.stub().resolves({
        maxFeePerGas: BigNumber.from(10_000_000_000n),
        gasPrice: BigNumber.from(10_000_000_000n),
      }),
    };
    const multiProvider = {
      getDomainId: Sinon.stub().returns(42161),
      getProtocol: Sinon.stub().returns(protocol),
      getProvider: Sinon.stub().returns(mockProvider),
    } as unknown as MultiProvider;

    const getTokenForChain = Sinon.stub().returns(mockToken);
    const isNativeTokenStandard = Sinon.stub().returns(true);

    return {
      multiProvider,
      getTokenForChain,
      isNativeTokenStandard,
      mockAdapter,
      mockProvider,
    };
  }

  it('uses one quote consistently for EVM-native reservation and estimation', async () => {
    const {
      multiProvider,
      getTokenForChain,
      isNativeTokenStandard,
      mockAdapter,
    } = createMockDeps(ProtocolType.Ethereum);
    mockAdapter.quoteTransferRemoteGas
      .onSecondCall()
      .rejects(new Error('duplicate quote'));
    const result = await calculateTransferCosts(
      'ethereum',
      'arbitrum',
      3_000_000_000_000_000n,
      3_000_000_000_000_000n,
      multiProvider,
      {},
      getTokenForChain,
      '0xInventorySigner',
      isNativeTokenStandard,
      testLogger,
    );
    expect(mockAdapter.quoteTransferRemoteGas.callCount).to.equal(1);
    expect(
      mockAdapter.populateTransferRemoteTx.firstCall.args[0].interchainGas,
    ).to.equal(result.gasQuote);
    expect(result.igpCost).to.equal(1000n);
    expect(result.gasCost).to.equal(2_200_000_000_000_000n);
    expect(result.totalCost).to.equal(2_200_000_000_001_000n);
    expect(result.maxTransferable).to.equal(799_999_999_999_000n);
    expect(result.minViableTransfer).to.equal(4_400_000_000_002_000n);
  });

  it('retains the fallback gas reserve when estimation fails', async () => {
    const {
      multiProvider,
      getTokenForChain,
      isNativeTokenStandard,
      mockAdapter,
      mockProvider,
    } = createMockDeps(ProtocolType.Ethereum);
    mockProvider.estimateGas.rejects(new Error('estimate unavailable'));
    const result = await calculateTransferCosts(
      'ethereum',
      'arbitrum',
      10_000_000_000_000_000n,
      5_000_000_000_000_000n,
      multiProvider,
      {},
      getTokenForChain,
      '0xInventorySigner',
      isNativeTokenStandard,
      testLogger,
    );
    expect(mockAdapter.quoteTransferRemoteGas.callCount).to.equal(1);
    expect(result.gasCost).to.equal(3_300_000_000_000_000n);
    expect(result.igpCost).to.equal(1000n);
  });

  it('still obtains a quote for standalone gas estimation', async () => {
    const { multiProvider, getTokenForChain, mockAdapter } = createMockDeps(
      ProtocolType.Ethereum,
    );
    const estimate = await estimateTransferRemoteGas(
      'ethereum',
      'arbitrum',
      100n,
      multiProvider,
      {},
      getTokenForChain,
      '0xInventorySigner',
      testLogger,
    );
    expect(estimate).to.equal(200000n);
    expect(mockAdapter.quoteTransferRemoteGas.callCount).to.equal(1);
    expect(mockAdapter.quoteTransferRemoteGas.firstCall.args[0]).to.deep.equal({
      destination: 42161,
      sender: '0xInventorySigner',
      recipient: '0xInventorySigner',
      amount: 100n,
    });
  });

  it('Tron origin (EVM-like) produces non-zero gasCost for native tokens', async () => {
    const { multiProvider, getTokenForChain, isNativeTokenStandard } =
      createMockDeps(ProtocolType.Tron);

    const result = await calculateTransferCosts(
      'tron' as ChainName,
      'arbitrum' as ChainName,
      10000000000000000000n, // 10 ETH available
      1000000000000000000n, // 1 ETH requested
      multiProvider,
      {} as any, // warpCoreMultiProvider
      getTokenForChain,
      '0xInventorySigner',
      isNativeTokenStandard,
      testLogger,
    );

    // Tron is EVM-like — gas estimation runs, producing gasCost > 0
    expect(result.gasCost > 0n).to.be.true;
    expect(result.igpCost).to.equal(1000n);
    expect(result.maxTransferable > 0n).to.be.true;
  });

  it('Sealevel origin (non-EVM) returns gasCost = 0 for native tokens', async () => {
    const { multiProvider, getTokenForChain, isNativeTokenStandard } =
      createMockDeps(ProtocolType.Sealevel);

    const result = await calculateTransferCosts(
      'solana' as ChainName,
      'arbitrum' as ChainName,
      200000000000n,
      100000000000n,
      multiProvider,
      {} as any,
      getTokenForChain,
      '0xInventorySigner',
      isNativeTokenStandard,
      testLogger,
    );

    // Sealevel is non-EVM — gasCost is 0 (skips gas estimation)
    expect(result.gasCost).to.equal(0n);
    expect(result.igpCost).to.equal(1000n);
  });
});
