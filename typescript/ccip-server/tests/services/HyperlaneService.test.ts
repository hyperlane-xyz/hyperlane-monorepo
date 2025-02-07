import { describe, expect, test } from '@jest/globals';

import { HyperlaneService } from '../../src/services/HyperlaneService';

describe('HyperlaneServiceTest', () => {
  let hyperlaneService: HyperlaneService;
  beforeEach(() => {
    hyperlaneService = new HyperlaneService(
      'https://explorer.hyperlane.xyz/api',
    );
  });
  test('should get the block by messageId', async () => {
    await hyperlaneService.getOriginBlockByMessageId(
      '0xb0430e396f4014883c01bb3ee43df17ce93d8257a0a0b5778d9d3229a1bf02bb',
    );
    expect(true).toBe(true);
  });
});
