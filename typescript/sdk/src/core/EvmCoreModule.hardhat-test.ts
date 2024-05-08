import { expect } from 'chai';

import { TestChainName } from '../consts/testChains.js';
import { CoreConfig } from '../core/types.js';
import { testCoreConfig } from '../test/testUtils.js';

import { EvmCoreModule } from './EvmCoreModule.js';

describe('EvmCoreModule', async () => {
  describe('Create', async () => {
    it('should deploy the ISM factory', async () => {
      const evmCoreModule = await EvmCoreModule.create({
        chain: TestChainName.test1,
        config: testCoreConfig([]) as CoreConfig,
      });

      expect(evmCoreModule.addresses.proxyAdmin).to.be.not.undefined;
    });
    it('should deploy a proxyAdmin and add it to the config', async () => {
      const evmCoreModule = await EvmCoreModule.create({
        chain: TestChainName.test1,
        config: testCoreConfig([]) as CoreConfig,
      });

      expect(evmCoreModule.addresses.proxyAdmin).to.be.not.undefined;
    });
  });
});
