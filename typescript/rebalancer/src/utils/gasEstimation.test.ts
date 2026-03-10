import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { ChainName, MultiProvider, Token } from '@hyperlane-xyz/sdk';
import { TokenStandard } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { calculateTransferCosts } from './gasEstimation.js';

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

    const multiProvider = {
      getDomainId: Sinon.stub().returns(42161),
      getProtocol: Sinon.stub().returns(protocol),
      getProvider: Sinon.stub().returns({
        estimateGas: Sinon.stub().resolves(BigNumber.from(200000)),
        getFeeData: Sinon.stub().resolves({
          maxFeePerGas: BigNumber.from(10_000_000_000n),
          gasPrice: BigNumber.from(10_000_000_000n),
        }),
      }),
    } as unknown as MultiProvider;

    const getTokenForChain = Sinon.stub().returns(mockToken);
    const isNativeTokenStandard = Sinon.stub().returns(true);

    return { multiProvider, getTokenForChain, isNativeTokenStandard };
  }

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
