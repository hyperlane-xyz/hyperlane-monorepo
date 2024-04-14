import { expect } from 'chai';
import { ethers } from 'ethers';

import { ethereum } from '../consts/chainMetadata.js';
import { Chains } from '../consts/chains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ProviderType } from '../providers/ProviderType.js';

import { MultiProtocolCore } from './MultiProtocolCore.js';
import { EvmCoreAdapter } from './adapters/EvmCoreAdapter.js';

describe('MultiProtocolCore', () => {
  describe('constructs', () => {
    it('with constructor', () => {
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
    it('from environment', () => {
      const multiProvider = new MultiProtocolProvider();
      const core = MultiProtocolCore.fromEnvironment('mainnet', multiProvider);
      expect(core).to.be.instanceOf(MultiProtocolCore);
      const ethAdapter = core.adapter(Chains.ethereum);
      expect(ethAdapter).to.be.instanceOf(EvmCoreAdapter);
    });
  });

  // TODO: update for v3
  describe.skip('checks delivery', () => {
    it('to EVM', async () => {
      const multiProvider = new MultiProtocolProvider();
      const core = MultiProtocolCore.fromEnvironment('mainnet', multiProvider);
      // https://arbiscan.io//tx/0x9da03376486327fc9b1e8069538e0fef91641055cb3a2ff89460c7955ab68264#eventlog
      const receipt = {
        transactionHash:
          '0x9da03376486327fc9b1e8069538e0fef91641055cb3a2ff89460c7955ab68264',
        logs: [
          {
            data: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000005300000013670000a4b100000000000000000000000096271ca0ab9eefb3ca481749c0ca4c705fd4f523000000890000000000000000000000006c0ac8cea75232aa7bed8cbe9c4f820e7a77a9c348656c6c6f2100000000000000000000000000',
            topics: [
              '0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814',
              '0x00000000000000000000000096271ca0ab9eefb3ca481749c0ca4c705fd4f523',
              '0x0000000000000000000000000000000000000000000000000000000000000089',
              '0x0000000000000000000000006c0ac8cea75232aa7bed8cbe9c4f820e7a77a9c3',
            ],
          },
        ],
      } as ethers.providers.TransactionReceipt;
      // Should return immediately
      await core.waitForMessagesProcessed(Chains.arbitrum, Chains.polygon, {
        type: ProviderType.EthersV5,
        receipt,
      });
    }).timeout(10000);

    it('to Sealevel', async () => {
      const multiProvider = new MultiProtocolProvider();
      const core = MultiProtocolCore.fromEnvironment('mainnet', multiProvider);
      // https://arbiscan.io//tx/0x9da03376486327fc9b1e8069538e0fef91641055cb3a2ff89460c7955ab68264#eventlog
      const receipt = {
        transactionHash:
          '0x9da03376486327fc9b1e8069538e0fef91641055cb3a2ff89460c7955ab68264',
        logs: [
          {
            data: '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000053000000136d0000a4b100000000000000000000000096271ca0ab9eefb3ca481749c0ca4c705fd4f523536f6c4d3797d0096b18b5b645c346a66d7f18c6c5738782c6bce24da57a3462bdef82b148656c6c6f2100000000000000000000000000',
            topics: [
              '0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814',
              '0x00000000000000000000000096271ca0ab9eefb3ca481749c0ca4c705fd4f523',
              '0x00000000000000000000000000000000000000000000000000000000536f6c4d',
              '0x3797d0096b18b5b645c346a66d7f18c6c5738782c6bce24da57a3462bdef82b1',
            ],
          },
        ],
      } as ethers.providers.TransactionReceipt;
      // Should return immediately
      await core.waitForMessagesProcessed(Chains.arbitrum, Chains.solana, {
        type: ProviderType.EthersV5,
        receipt,
      });
    }).timeout(10000);
  });
});
