import { MultiProvider } from '../providers/MultiProvider.js';

import { HyperlaneCore } from './HyperlaneCore.js';

describe('HyperlaneCore', () => {
  describe('fromEnvironment', () => {
    it('creates an object for mainnet', async () => {
      const multiProvider = new MultiProvider();
      HyperlaneCore.fromEnvironment('mainnet', multiProvider);
    });
    it('creates an object for testnet', async () => {
      const multiProvider = new MultiProvider();
      HyperlaneCore.fromEnvironment('testnet', multiProvider);
    });
  });
});
