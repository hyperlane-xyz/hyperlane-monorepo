import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { HyperlaneService } from '../../src/services/HyperlaneService';

describe('HyperlaneServiceTest', () => {
  let hyperlaneService: HyperlaneService;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    hyperlaneService = new HyperlaneService(
      'test-service',
      'https://explorer.hyperlane.xyz/api',
    );
    jest.clearAllMocks();
  });

  test('should get the block by messageId', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      json: async () => ({
        status: '1',
        message: 'ok',
        result: [{ origin: { blockNumber: 12345 } }],
      }),
    } as any);

    const result = await hyperlaneService.getOriginBlockByMessageId(
      '0xb0430e396f4014883c01bb3ee43df17ce93d8257a0a0b5778d9d3229a1bf02bb',
      logger as any,
    );

    expect(result).toEqual({ blockNumber: 12345 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('should get the transaction hash by messageId', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        data: {
          raw_message_dispatch: [{ origin_tx_hash: '\\x1234' }],
        },
      }),
    } as any);

    const result = await hyperlaneService.getOriginTransactionHashByMessageId(
      '0xb0430e396f4014883c01bb3ee43df17ce93d8257a0a0b5778d9d3229a1bf02bb',
      logger as any,
    );

    expect(result).toEqual('0x1234');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
