import { expect } from 'chai';

import { ethereum } from '../consts/chainMetadata';
import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

import { MultiProtocolCore } from './MultiProtocolCore';
import { EvmCoreAdapter } from './adapters/EvmCoreAdapter';
import { CoreAddresses } from './contracts';

describe('MultiProtocolCore', () => {
  describe('constructs', () => {
    it('with constructor', async () => {
      const multiProvider = new MultiProtocolProvider<CoreAddresses>({
        ethereum: {
          ...ethereum,
          validatorAnnounce: '0x123',
          proxyAdmin: '0x123',
          mailbox: '0x123',
        },
      });
      const core = new MultiProtocolCore(multiProvider);
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
