import { expect } from 'chai';
import { ethers } from 'ethers';

import { Chains } from '../consts/chains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

import { MultiProtocolRouterApp } from './MultiProtocolRouterApps.js';
import { EvmRouterAdapter } from './adapters/EvmRouterAdapter.js';
import { RouterAddress } from './types.js';

describe('MultiProtocolRouterApp', () => {
  describe('constructs', () => {
    const multiProvider = new MultiProtocolProvider<RouterAddress>();
    it('creates an app class', async () => {
      const addresses = {
        ethereum: { router: ethers.constants.AddressZero },
      };
      const app = new MultiProtocolRouterApp(
        multiProvider.intersect(Object.keys(addresses)).result,
        addresses,
      );
      expect(app).to.be.instanceOf(MultiProtocolRouterApp);
      const ethAdapter = app.adapter(Chains.ethereum);
      expect(ethAdapter).to.be.instanceOf(EvmRouterAdapter);
      expect(!!ethAdapter.remoteRouter).to.be.true;
    });
  });
});
