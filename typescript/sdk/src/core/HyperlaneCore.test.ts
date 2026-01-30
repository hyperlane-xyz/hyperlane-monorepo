import { MultiProvider } from '../providers/MultiProvider.js';

import { HyperlaneCore } from './HyperlaneCore.js';

describe('HyperlaneCore', () => {
  describe('fromEnvironment', () => {
    // eslint-disable-next-line jest/expect-expect -- testing factory doesn't throw
    it('creates an object for testnet', async () => {
      const multiProvider = MultiProvider.createTestMultiProvider();
      HyperlaneCore.fromAddressesMap({ test1: {} }, multiProvider);
    });
  });
});
