import { expect } from 'chai';
import { ethers } from 'ethers';

import { TestChainName } from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

import { MultiProtocolRouterApp } from './MultiProtocolRouterApps.js';
import { EvmRouterAdapter } from './adapters/EvmRouterAdapter.js';
import { RouterAddress } from './types.js';

describe('MultiProtocolRouterApp', () => {
  describe('constructs', () => {
    const multiProvider =
      MultiProtocolProvider.createTestMultiProtocolProvider<RouterAddress>();
    it('creates an app class', async () => {
      const addresses = {
        test1: { router: ethers.constants.AddressZero },
      };
      const app = new MultiProtocolRouterApp(
        multiProvider.intersect(Object.keys(addresses)).result,
        addresses,
      );
      expect(app).to.be.instanceOf(MultiProtocolRouterApp);
      const ethAdapter = app.adapter(TestChainName.test1);
      expect(ethAdapter).to.be.instanceOf(EvmRouterAdapter);
      expect(!!ethAdapter.remoteRouter).to.be.true;
    });
  });
});
