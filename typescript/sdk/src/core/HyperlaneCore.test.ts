import { MultiProvider } from '../providers/MultiProvider.js';

import { HyperlaneCore } from './HyperlaneCore.js';

describe('HyperlaneCore', () => {
  describe('fromEnvironment', () => {
    it('creates an object for testnet', async () => {
      const multiProvider = MultiProvider.createTestMultiProvider();
      HyperlaneCore.fromAddressesMap({ test1: {} }, multiProvider);
    });
  });
});
