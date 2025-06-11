import { jest, describe, beforeEach, afterAll, it, expect, test } from '@jest/globals';
import { getStatus as getStatusClient, StatusResponse } from '../client';
import { getStatus, parseStatusResponse } from './status';

jest.mock('../client', () => ({
  getStatus: jest.fn(),
}));

const mockedGetStatus = getStatusClient as jest.MockedFunction<typeof getStatusClient>;

/**
 * Helper to generate a valid StatusResponse, with optional overrides.
 */
function makeResponse(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    healthy: true,
    code: 200,
    message: 'Service is healthy',
    ...overrides,
  };
}

describe('getStatus', () => {
  beforeEach(() => {
    mockedGetStatus.mockClear();
  });

  afterAll(() => {
    jest.resetAllMocks();
  });

  describe('happy path', () => {
    it('returns the service response when healthy', async () => {
      const response = makeResponse();
      mockedGetStatus.mockResolvedValue(response);

      const result = await getStatus();

      expect(mockedGetStatus).toHaveBeenCalledTimes(1);
      expect(result).toEqual(response);
    });
  });

  describe('service down', () => {
    it('returns healthy=false and the error message on network failure', async () => {
      mockedGetStatus.mockRejectedValue(new Error('Network error'));

      const result = await getStatus();

      expect(result.healthy).toBe(false);
      expect(result.message).toBe('Network error');
      expect(result.code).toBe(-1);
    });
  });

  describe('timeout', () => {
    it('returns healthy=false and timeout message on timeout', async () => {
      mockedGetStatus.mockRejectedValue(new Error('Timeout'));

      const result = await getStatus();

      expect(result.healthy).toBe(false);
      expect(result.message).toBe('Timeout');
      expect(result.code).toBe(-1);
    });
  });
});

describe('parseStatusResponse edge cases', () => {
  it('falls back to defaults when fields are missing', () => {
    const result = parseStatusResponse({} as any);
    expect(result).toEqual({ healthy: false, code: -1, message: '' });
  });

  it('throws when given an invalid response type', () => {
    expect(() => parseStatusResponse(null as any)).toThrow();
  });
});

describe('parseStatusResponse parameterized HTTP codes', () => {
  ;(test as any).each([
    [200, true],
    [500, false],
    [404, false],
  ])('status code %i → healthy=%s', (code: number, expectedHealthy: boolean) => {
    const raw = makeResponse({ code, healthy: undefined as any });
    const parsed = parseStatusResponse(raw);
    expect(parsed.healthy).toBe(expectedHealthy);
    expect(parsed.code).toBe(code);
  });
});