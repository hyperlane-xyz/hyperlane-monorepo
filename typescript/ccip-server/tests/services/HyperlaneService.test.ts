import { afterEach, describe, expect, jest, test } from '@jest/globals';
import pino from 'pino';

import { HyperlaneService } from '../../src/services/HyperlaneService';

describe('HyperlaneServiceTest', () => {
  const logger = pino({ enabled: false });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should get the block by messageId', async () => {
    const origin = {
      transactionHash: '0xabc',
      blockHash: '0xdef',
      blockNumber: 1,
      timestamp: 123456,
    };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({
        status: '1',
        message: '',
        result: [{ origin }],
      }),
    } as unknown as Response);

    const hyperlaneService = new HyperlaneService(
      'test-service',
      'https://explorer.hyperlane.xyz/api',
    );
    const result = await hyperlaneService.getOriginBlockByMessageId(
      '0xb0430e396f4014883c01bb3ee43df17ce93d8257a0a0b5778d9d3229a1bf02bb',
      logger,
    );

    expect(result).toEqual(origin);
  });
});
