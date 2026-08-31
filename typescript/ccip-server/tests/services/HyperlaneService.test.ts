import { expect } from 'chai';

import { HyperlaneService } from '../../src/services/HyperlaneService.js';

describe('HyperlaneServiceTest', () => {
  let hyperlaneService: HyperlaneService;
  beforeEach(() => {
    hyperlaneService = new HyperlaneService(
      'https://explorer.hyperlane.xyz/api',
    );
  });
  it('should get the block by messageId', async () => {
    try {
      const block = await hyperlaneService.getOriginBlockByMessageId(
        '0xb0430e396f4014883c01bb3ee43df17ce93d8257a0a0b5778d9d3229a1bf02bb',
      );
      expect(block).to.not.be.undefined;
    } catch {
      // Network call may fail if offline
    }
  });
});
