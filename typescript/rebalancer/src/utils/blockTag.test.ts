import { expect } from 'vitest';
import { providers } from 'ethers';

import { MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { getConfirmedBlockTag } from './blockTag.js';

describe('getConfirmedBlockTag', () => {
  let mpp: MultiProtocolProvider;

  beforeEach(() => {
    mpp = {
      getChainMetadata: vi.fn(),
      getEthersV5Provider: vi.fn(),
    } as unknown as MultiProtocolProvider;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a confirmed block number for Tron chain (EVM-like)', async () => {
    (mpp.getChainMetadata as any).mockReturnValue({
      protocol: ProtocolType.Tron,
      name: 'tron',
      chainId: 728126428,
      blocks: { reorgPeriod: 20 },
    });

    const mockProvider = {
      send: vi.fn().mockResolvedValue('0x64'), // 100 in hex
      getBlockNumber: vi.fn().mockResolvedValue(100),
    };
    // Make instanceof check pass
    Object.setPrototypeOf(mockProvider, providers.JsonRpcProvider.prototype);
    (mpp.getEthersV5Provider as any).mockReturnValue(mockProvider);

    const result = await getConfirmedBlockTag(mpp, 'tron');
    // 100 - 20 = 80
    expect(result).toBe(80);
  });

  it('returns undefined for Sealevel chain (non-EVM-like)', async () => {
    (mpp.getChainMetadata as any).mockReturnValue({
      protocol: ProtocolType.Sealevel,
      name: 'solana',
      chainId: 1399811149,
    });

    const result = await getConfirmedBlockTag(mpp, 'solana');
    expect(result).toBeUndefined();
  });

  it('returns undefined for Tron chain with string reorgPeriod (named block tags not supported)', async () => {
    const logger = { warn: vi.fn() };
    (mpp.getChainMetadata as any).mockReturnValue({
      protocol: ProtocolType.Tron,
      name: 'tron',
      chainId: 728126428,
      blocks: { reorgPeriod: 'finalized' },
    });

    const result = await getConfirmedBlockTag(mpp, 'tron', logger as any);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][1]).toContain(
      'Tron does not support named block tags',
    );
  });
});
