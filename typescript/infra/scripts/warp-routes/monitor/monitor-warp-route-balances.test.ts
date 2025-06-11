import { jest } from '@jest/globals';
import monitorWarpRouteBalances, { isBelowThreshold } from './monitor-warp-route-balances';

jest.mock('../../../lib/someClient', () => ({
  getBalances: jest.fn(),
}));
const mockedClient = require('../../../lib/someClient') as jest.Mocked<typeof import('../../../lib/someClient')>;

const DEFAULT_THRESHOLD = '10';
const OLD_ENV = process.env;

describe('monitorWarpRouteBalances', () => {
  beforeEach(() => {
    // Override the threshold for each test
    process.env = { ...OLD_ENV, BALANCE_THRESHOLD: DEFAULT_THRESHOLD };
    jest.resetAllMocks();
  });

  afterAll(() => {
    // Restore original environment
    process.env = OLD_ENV;
  });

  it('returns alert=false when all balances above threshold', async () => {
    // Arrange
    mockedClient.getBalances.mockResolvedValue([{ token: 'WARP', balance: '1000' }]);

    // Act
    const result = await monitorWarpRouteBalances();

    // Assert
    expect(result.alert).toBe(false);
    expect(result.lowBalances).toHaveLength(0);
  });

  it('returns alert=true when a balance is below threshold', async () => {
    // Arrange
    mockedClient.getBalances.mockResolvedValue([{ token: 'WARP', balance: '1' }]);

    // Act
    const result = await monitorWarpRouteBalances();

    // Assert
    expect(result.alert).toBe(true);
    expect(result.lowBalances).toHaveLength(1);
    expect(result.lowBalances[0]).toMatchObject({ token: 'WARP', balance: '1' });
  });

  it('handles empty balance list gracefully', async () => {
    // Arrange
    mockedClient.getBalances.mockResolvedValue([]);

    // Act
    const result = await monitorWarpRouteBalances();

    // Assert
    expect(result.alert).toBe(false);
    expect(result.lowBalances).toHaveLength(0);
  });

  it('propagates unexpected errors', async () => {
    // Arrange
    const error = new Error('network down');
    mockedClient.getBalances.mockRejectedValue(error);

    // Act & Assert
    await expect(monitorWarpRouteBalances()).rejects.toThrow(error);
  });
});

describe('isBelowThreshold', () => {
  it('returns true when balance is lower than threshold', () => {
    expect(isBelowThreshold('9', '10')).toBe(true);
  });

  it('returns false when balance is equal to or higher than threshold', () => {
    expect(isBelowThreshold('10', '10')).toBe(false);
    expect(isBelowThreshold('11', '10')).toBe(false);
  });
});