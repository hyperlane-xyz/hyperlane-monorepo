import { chainConnectionConfigs } from '../consts/chainConnectionConfigs';
import { MultiProvider } from '../providers/MultiProvider';

import { HyperlaneCore } from './HyperlaneCore';

describe('HyperlaneCore', () => {
  describe('fromEnvironment', () => {
    it('creates an object for mainnet', async () => {
      const multiProvider = new MultiProvider(chainConnectionConfigs);
      HyperlaneCore.fromEnvironment('mainnet', multiProvider);
    });
  });
});
