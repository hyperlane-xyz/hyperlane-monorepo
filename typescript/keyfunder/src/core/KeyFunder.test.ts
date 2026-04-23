import type { Logger } from 'pino';
import { expect, vi } from 'vitest';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';

import { KeyFunder } from './KeyFunder.js';

describe('KeyFunder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should continue funding when recordFunderBalance fails', async () => {
    const chainWarnSpy = vi.fn();
    const chainInfoSpy = vi.fn();

    const chainLogger = {
      child: () => chainLogger,
      debug: () => undefined,
      error: () => undefined,
      info: (...args: unknown[]) => chainInfoSpy(...args),
      warn: (...args: unknown[]) => chainWarnSpy(...args),
    } as unknown as Logger;

    const logger = {
      child: () => chainLogger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;

    const multiProvider = {} as MultiProvider;

    const config: KeyFunderConfig = {
      version: '1',
      roles: {
        relayer: { address: '0x1111111111111111111111111111111111111111' },
      },
      chains: {
        ethereum: {
          balances: {
            relayer: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger,
    });
    const recordFunderBalanceStub = vi
      .spyOn(
        keyFunder as unknown as {
          recordFunderBalance: (chain: string) => Promise<void>;
        },
        'recordFunderBalance',
      )
      .mockRejectedValue(new Error('RPC failure'));

    const fundKeysStub = vi
      .spyOn(
        keyFunder as unknown as {
          fundKeys: (chain: string, keys: unknown[]) => Promise<void>;
        },
        'fundKeys',
      )
      .mockResolvedValue(undefined);

    await keyFunder.fundChain('ethereum');

    expect(recordFunderBalanceStub).toHaveBeenCalledOnce();
    expect(fundKeysStub).toHaveBeenCalledOnce();
    expect(chainWarnSpy).toHaveBeenCalledOnce();
    const warnArgs = chainWarnSpy.mock.calls[0];
    expect(warnArgs[1]).toBe(
      'Failed to record funder balance metric, continuing',
    );
    expect((warnArgs[0] as { error: unknown }).error).toBeInstanceOf(Error);

    expect(chainInfoSpy).toHaveBeenCalledOnce();
    const infoArgs = chainInfoSpy.mock.calls[0];
    expect(infoArgs[1]).toBe('Chain funding completed');
    expect(
      (infoArgs[0] as { durationSeconds: unknown }).durationSeconds,
    ).toBeTypeOf('number');
  });
});
