import { expect } from 'vitest';
import { BigNumber } from 'ethers';
import { pino } from 'pino';

import type { ChainName, MultiProvider, Token } from '@hyperlane-xyz/sdk';
import { TokenStandard } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { calculateTransferCosts } from './gasEstimation.js';

const testLogger = pino({ level: 'silent' });

describe('calculateTransferCosts — Tron vs Sealevel protocol path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockDeps(protocol: ProtocolType) {
    const mockAdapter = {
      quoteTransferRemoteGas: vi.fn().mockResolvedValue({
        igpQuote: { amount: 1000n },
        tokenFeeQuote: { amount: 0n, addressOrDenom: '' },
      }),
      populateTransferRemoteTx: vi.fn().mockResolvedValue({
        to: '0xRouter',
        data: '0x',
        value: 1000n,
      }),
    };

    const mockToken = {
      standard: TokenStandard.EvmHypNative, // Native so we reach the isEVMLike check
      getHypAdapter: vi.fn().mockReturnValue(mockAdapter),
    } as unknown as Token;

    const multiProvider = {
      getDomainId: vi.fn().mockReturnValue(42161),
      getProtocol: vi.fn().mockReturnValue(protocol),
      getProvider: vi.fn().mockReturnValue({
        estimateGas: vi.fn().mockResolvedValue(BigNumber.from(200000)),
        getFeeData: vi.fn().mockResolvedValue({
          maxFeePerGas: BigNumber.from(10_000_000_000n),
          gasPrice: BigNumber.from(10_000_000_000n),
        }),
      }),
    } as unknown as MultiProvider;

    const getTokenForChain = vi.fn().mockReturnValue(mockToken);
    const isNativeTokenStandard = vi.fn().mockReturnValue(true);

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
    expect(result.gasCost > 0n).toBe(true);
    expect(result.igpCost).toBe(1000n);
    expect(result.maxTransferable > 0n).toBe(true);
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
    expect(result.gasCost).toBe(0n);
    expect(result.igpCost).toBe(1000n);
  });
});
