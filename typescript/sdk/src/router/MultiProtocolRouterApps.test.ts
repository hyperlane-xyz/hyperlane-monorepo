import { expect } from 'chai';
import { ethers } from 'ethers';

import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

import { MultiProtocolRouterApp } from './MultiProtocolRouterApps';
import { EvmRouterAdapter } from './adapters/EvmRouterAdapter';
import { RouterAddress } from './types';

describe('MultiProtocolRouterApp', () => {
  describe('constructs', () => {
    const multiProvider = new MultiProtocolProvider<RouterAddress>();
    it('creates an app class', async () => {
      const app = new MultiProtocolRouterApp(multiProvider, {
        ethereum: { router: ethers.constants.AddressZero },
      });
      expect(app).to.be.instanceOf(MultiProtocolRouterApp);
      const ethAdapter = app.adapter(Chains.ethereum);
      expect(ethAdapter).to.be.instanceOf(EvmRouterAdapter);
      expect(!!ethAdapter.remoteRouter).to.be.true;
    });
  });
});
