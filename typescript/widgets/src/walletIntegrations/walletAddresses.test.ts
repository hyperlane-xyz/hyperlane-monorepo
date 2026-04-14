import assert from 'node:assert/strict';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { getAddressForChain } from './walletAddresses.js';

describe('walletAddresses', () => {
  describe('getAddressForChain', () => {
    it('returns undefined for missing addresses', () => {
      assert.equal(
        getAddressForChain(undefined, ProtocolType.Ethereum, 'ethereum'),
        undefined,
      );
      assert.equal(
        getAddressForChain([], ProtocolType.Ethereum, 'ethereum'),
        undefined,
      );
    });

    it('returns exact chain match when present', () => {
      assert.equal(
        getAddressForChain(
          [
            { address: '0xaaa', chainName: 'ethereum' },
            { address: '0xbbb', chainName: 'base' },
          ],
          ProtocolType.Ethereum,
          'base',
        ),
        '0xbbb',
      );
    });

    it('falls back to first address for non-Cosmos protocols', () => {
      assert.equal(
        getAddressForChain(
          [
            { address: '0xaaa', chainName: 'ethereum' },
            { address: '0xbbb', chainName: 'base' },
          ],
          ProtocolType.Ethereum,
          'arbitrum',
        ),
        '0xaaa',
      );
    });

    it('does not fall back across Cosmos chains', () => {
      assert.equal(
        getAddressForChain(
          [
            { address: 'cosmos1abc', chainName: 'cosmoshub' },
            { address: 'osmo1def', chainName: 'osmosis' },
          ],
          ProtocolType.Cosmos,
          'neutron',
        ),
        undefined,
      );

      assert.equal(
        getAddressForChain(
          [{ address: 'cosmos1abc', chainName: 'cosmoshub' }],
          ProtocolType.CosmosNative,
          'neutron',
        ),
        undefined,
      );
    });

    it('still returns exact Cosmos chain match when present', () => {
      assert.equal(
        getAddressForChain(
          [
            { address: 'cosmos1abc', chainName: 'cosmoshub' },
            { address: 'osmo1def', chainName: 'osmosis' },
          ],
          ProtocolType.Cosmos,
          'osmosis',
        ),
        'osmo1def',
      );
    });
  });
});
