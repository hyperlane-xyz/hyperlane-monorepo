/**
 * Jest is used as the testing framework for this project (see jest.config.js/ts).
 */

import { describe, beforeEach, afterAll, test, expect, jest } from '@jest/globals';
import axios from 'axios';
import fs from 'fs/promises';
import { exec } from 'child_process';
import {
  checkRouteStatus,
  validateConfig,
  calculateLatency,
  THRESHOLDS,
  MAX_RETRIES,
  ValidationError
} from './status';

jest.mock('axios');
jest.mock('fs/promises');
jest.mock('child_process', () => ({ exec: jest.fn() }));

describe('checkRouteStatus', () => {
  const mockConfig = { url: 'http://example.com', threshold: THRESHOLDS.healthy, maxRetries: MAX_RETRIES };
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  const sampleResponse = { status: 200, data: { hello: 'world' } };

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('Happy path: returns healthy status when HTTP succeeds', async () => {
    (axios.get as jest.Mock).mockResolvedValueOnce(sampleResponse);
    const result = await checkRouteStatus(mockConfig);
    expect(result).toEqual({
      url: mockConfig.url,
      statusCode: 200,
      healthy: true,
      latency: expect.any(Number),
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(/success/i),
      expect.objectContaining({ url: mockConfig.url })
    );
  });

  test('Route down: HTTP 5xx error triggers graceful failure', async () => {
    (axios.get as jest.Mock).mockRejectedValueOnce(new Error('Server Error'));
    await expect(checkRouteStatus(mockConfig)).rejects.toThrow(/down/i);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/error/i),
      expect.any(Error)
    );
  });

  test('Invalid config: validateConfig throws on bad input', () => {
    expect(() => validateConfig({} as any)).toThrow(ValidationError);
    expect(() => validateConfig({} as any)).toThrow(/config/i);
  });

  test('Edge timing thresholds: exactly healthy and degraded boundaries', () => {
    // exactly healthy threshold
    expect(calculateLatency(0, THRESHOLDS.healthy)).toEqual(THRESHOLDS.healthy);
    // below healthy threshold
    expect(calculateLatency(0, THRESHOLDS.healthy - 1)).toEqual(THRESHOLDS.healthy - 1);
    // above degraded threshold
    expect(calculateLatency(0, THRESHOLDS.degraded + 1)).toEqual(THRESHOLDS.degraded + 1);
  });

  test('Retry logic: fails twice then succeeds within maxRetries', async () => {
    (axios.get as jest.Mock)
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockResolvedValueOnce(sampleResponse);

    const result = await checkRouteStatus(mockConfig);
    expect(axios.get).toHaveBeenCalledTimes(3);
    expect(result.healthy).toBe(true);
  });
});