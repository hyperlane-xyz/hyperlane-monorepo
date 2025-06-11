import { jest } from '@jest/globals';
import { monitorWarpRouteBalances, __private__ } from './monitor-warp-route-balances';
import * as warpSdk from '../../warp-client';
import * as loggerModule from '../../logger';

describe('monitorWarpRouteBalances', () => {
  const mockFetchBalances = jest.fn();
  const mockInfo = jest.spyOn(loggerModule, 'info').mockImplementation(() => {});
  const mockError = jest.spyOn(loggerModule, 'error').mockImplementation(() => {});
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, MIN_BALANCE: '1000' };
    jest.spyOn(warpSdk, 'createClient').mockReturnValue({ fetchBalances: mockFetchBalances } as any);
    // prevent actual process.exit
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit:${code}`); }) as any);
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('resolves successfully when all balances >= threshold', async () => {
    mockFetchBalances.mockResolvedValue([{ token: 'USDC', balance: 1500 }]);
    await expect(monitorWarpRouteBalances()).resolves.toBeUndefined();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('All routes healthy'));
  });

  it('detects deficits and exits with non-zero code', async () => {
    mockFetchBalances.mockResolvedValue([{ token: 'DAI', balance: 500 }]);
    await expect(monitorWarpRouteBalances()).rejects.toThrow('process.exit:1');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Deficit detected'));
  });

  it('handles SDK failure by logging and exiting', async () => {
    mockFetchBalances.mockRejectedValue(new Error('network error'));
    await expect(monitorWarpRouteBalances()).rejects.toThrow('process.exit:1');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Error fetching balances'));
  });

  it('handles empty route list gracefully', async () => {
    mockFetchBalances.mockResolvedValue([]);
    await expect(monitorWarpRouteBalances()).resolves.toBeUndefined();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('No routes to monitor'));
  });
});

describe('calculateDeficit (unit)', () => {
  const { calculateDeficit } = __private__;

  test.each([
    [1500, 1000, 0],
    [999,  1000, 1],
    [0,    1000, 1000],
    [-100, 1000, 1100],
    [NaN,  1000, NaN],
  ])('balances %p vs min %p -> deficit %p', (balance, min, expected) => {
    expect(calculateDeficit(balance, min)).toStrictEqual(expected);
  });
});