import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypXERC20Lockbox__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { expect, vi } from 'vitest';

import { testChainMetadata } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { stubMultiProtocolProvider } from '../../test/multiProviderStubs.js';

import { EvmHypXERC20LockboxAdapter } from './EvmTokenAdapter.js';

describe('EvmHypXERC20LockboxAdapter', () => {
  let multiProvider: MultiProtocolProvider;

  const chainName = 'test1';
  const hypTokenAddress = '0x1111111111111111111111111111111111111111';
  const wrappedTokenAddress = '0x2222222222222222222222222222222222222222';

  beforeEach(() => {
    multiProvider = new MultiProtocolProvider(testChainMetadata);
    stubMultiProtocolProvider(multiProvider);

    vi.spyOn(HypERC20__factory, 'connect').mockReturnValue({} as any);
    vi.spyOn(TokenRouter__factory, 'connect').mockReturnValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads wrapped token from lockbox contract', async () => {
    const collateralWrappedToken = vi
      .fn()
      .mockRejectedValue(
        new Error('collateral wrappedToken should not be called'),
      );
    vi.spyOn(HypERC20Collateral__factory, 'connect').mockReturnValue({
      wrappedToken: collateralWrappedToken,
    } as any);

    const lockboxWrappedToken = vi.fn().mockResolvedValue(wrappedTokenAddress);
    vi.spyOn(HypXERC20Lockbox__factory, 'connect').mockReturnValue({
      wrappedToken: lockboxWrappedToken,
      lockbox: vi
        .fn()
        .mockResolvedValue('0x3333333333333333333333333333333333333333'),
      xERC20: vi
        .fn()
        .mockResolvedValue('0x4444444444444444444444444444444444444444'),
    } as any);

    const adapter = new EvmHypXERC20LockboxAdapter(chainName, multiProvider, {
      token: hypTokenAddress,
    });
    const wrapped = await adapter.getWrappedTokenAddress();

    expect(wrapped).toBe(wrappedTokenAddress);
    expect(lockboxWrappedToken).toHaveBeenCalledOnce();
    expect(collateralWrappedToken).not.toHaveBeenCalled();
  });
});
