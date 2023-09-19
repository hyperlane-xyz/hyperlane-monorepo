import { expect } from 'chai';
import { ethers } from 'ethers';

import { ethereum } from '../consts/chainMetadata';
import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

import { MultiProtocolCore } from './MultiProtocolCore';
import { EvmCoreAdapter } from './adapters/EvmCoreAdapter';

describe('MultiProtocolCore', () => {
  describe('constructs', () => {
    it('with constructor', async () => {
      const multiProvider = new MultiProtocolProvider({
        ethereum: {
          ...ethereum,
        },
      });
      const core = new MultiProtocolCore(multiProvider, {
        ethereum: {
          validatorAnnounce: ethers.constants.AddressZero,
          proxyAdmin: ethers.constants.AddressZero,
          mailbox: ethers.constants.AddressZero,
        },
      });
      expect(core).to.be.instanceOf(MultiProtocolCore);
      const ethAdapter = core.adapter(Chains.ethereum);
      expect(ethAdapter).to.be.instanceOf(EvmCoreAdapter);
    });
    it('from environment', async () => {
      const multiProvider = new MultiProtocolProvider();
      const core = MultiProtocolCore.fromEnvironment('mainnet', multiProvider);
      expect(core).to.be.instanceOf(MultiProtocolCore);
      const ethAdapter = core.adapter(Chains.ethereum);
      expect(ethAdapter).to.be.instanceOf(EvmCoreAdapter);
    });
  });
});
