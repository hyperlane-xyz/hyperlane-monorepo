import { describe, expect, jest, test } from '@jest/globals';
import { Spied } from 'jest-mock';

import { HyperlaneService } from '../../src/services/HyperlaneService';

describe('HyperlaneServiceTest', () => {
  let hyperlaneService: HyperlaneService;
  let fetchSpied: Spied<typeof fetch>;
  beforeEach(() => {
    hyperlaneService = new HyperlaneService(
      'https://explorer.hyperlane.xyz/api',
    );

    fetchSpied = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
  test('should get the block timestamp by messageId', async () => {
    const block = await hyperlaneService.getOriginBlockByMessageId(
      '0xb0430e396f4014883c01bb3ee43df17ce93d8257a0a0b5778d9d3229a1bf02bb',
    );
    expect(block.timestamp).toBe(1708538979000);
  });

  test('should throw if messageId does not exist', async () => {
    const badMessageId = '10xdeadbeef';
    try {
      await hyperlaneService.getOriginBlockByMessageId(badMessageId);
    } catch (e: any) {
      expect(e.message).toBe(`No message found for id: ${badMessageId}`);
    }
  });

  test('should throw an error if module or action no longer exists', async () => {
    fetchSpied.mockImplementation(() =>
      Promise.resolve({
        status: 200,
        json: async () => ({ status: 0, message: 'Invalid module or action' }),
      } as Response),
    );
    try {
      await hyperlaneService.getOriginBlockByMessageId(
        '0xb0430e396f4014883c01bb3ee43df17ce93d8257a0a0b5778d9d3229a1bf02bb',
      );
    } catch (e: any) {
      expect(e.message).toBe('Invalid module or action');
    }
  });
});
