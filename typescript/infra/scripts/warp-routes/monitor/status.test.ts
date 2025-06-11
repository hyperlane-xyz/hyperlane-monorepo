// Test suite using Jest
import { getStatus, fetchRemoteStatus, parseWarpResponse, WarpError } from './status';
import { get } from '../../utils/http';

jest.mock('../../utils/http', () => ({
  get: jest.fn(),
}));

const mockedGet = get as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('fetchRemoteStatus', () => {
  it('returns data when HTTP status is 200', async () => {
    const payload = { status: 'up', uptime: 100, nodes: 5 };
    mockedGet.mockResolvedValue({ status: 200, data: payload });
    await expect(fetchRemoteStatus()).resolves.toEqual(payload);
  });

  it('throws WarpError when HTTP status is not 200', async () => {
    mockedGet.mockResolvedValue({ status: 500, data: {} });
    await expect(fetchRemoteStatus()).rejects.toThrow(WarpError);
  });

  it('propagates error on network failure', async () => {
    mockedGet.mockRejectedValue(new Error('Network failure'));
    await expect(fetchRemoteStatus()).rejects.toThrow('Network failure');
  });
});

describe('getStatus', () => {
  it('returns parsed status object on success', async () => {
    const payload = { status: 'up', uptime: 100, nodes: 5 };
    mockedGet.mockResolvedValue({ status: 200, data: payload });
    const result = await getStatus();
    expect(result).toEqual(parseWarpResponse(payload));
  });

  it('throws WarpError when underlying fetchRemoteStatus fails due to non-200', async () => {
    mockedGet.mockResolvedValue({ status: 404, data: {} });
    await expect(getStatus()).rejects.toThrow(WarpError);
  });

  it('propagates network errors', async () => {
    mockedGet.mockRejectedValue(new Error('Timeout'));
    await expect(getStatus()).rejects.toThrow('Timeout');
  });
});

describe('parseWarpResponse', () => {
  const cases = [
    {
      name: 'full data',
      input: { status: 'healthy', uptime: 120, nodes: 3 },
      expected: { status: 'healthy', uptime: 120, nodes: 3 },
    },
    {
      name: 'missing uptime',
      input: { status: 'healthy', nodes: 2 },
      expected: { status: 'healthy', uptime: 0, nodes: 2 },
    },
    {
      name: 'missing nodes',
      input: { status: 'degraded', uptime: 50 },
      expected: { status: 'degraded', uptime: 50, nodes: 0 },
    },
    {
      name: 'extra fields are ignored',
      input: { status: 'degraded', uptime: 75, nodes: 1, extra: true },
      expected: { status: 'degraded', uptime: 75, nodes: 1 },
    },
  ];

  test.each(cases)('$name', ({ input, expected }) => {
    expect(parseWarpResponse(input)).toEqual(expected);
  });

  it('throws error if status field is missing or invalid', () => {
    expect(() => parseWarpResponse({ uptime: 10, nodes: 1 })).toThrow();
    expect(() => parseWarpResponse({ status: 123 })).toThrow();
  });
});