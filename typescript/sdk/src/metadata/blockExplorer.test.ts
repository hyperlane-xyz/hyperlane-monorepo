import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  test1,
  testCosmosChain,
  testSealevelChain,
  testStarknetChain,
} from '../consts/testChains.js';

import {
  getExplorerAddressUrl,
  getExplorerApi,
  getExplorerApiUrl,
  getExplorerBaseUrl,
  getExplorerTxUrl,
} from './blockExplorer.js';

const TEST_CHAINS = [
  test1,
  testCosmosChain,
  testSealevelChain,
  testStarknetChain,
];
const EXPECTED_RESULTS = [
  [
    'https://etherscan.io/',
    'https://api.etherscan.io/api?apikey=fakekey',
    'https://etherscan.io/tx/0x123',
    'https://etherscan.io/address/0x123',
  ],
  [
    'https://www.mintscan.io/cosmos',
    null,
    'https://www.mintscan.io/cosmos/tx/0x123',
    'https://www.mintscan.io/cosmos/address/0x123',
  ],
  [
    'https://explorer.solana.com/?cluster=devnet',
    null,
    'https://explorer.solana.com/tx/0x123?cluster=devnet',
    'https://explorer.solana.com/address/0x123?cluster=devnet',
  ],
  [
    'https://sepolia.voyager.online/',
    null,
    'https://sepolia.voyager.online/tx/0x123',
    'https://sepolia.voyager.online/contract/0x123',
  ],
];

describe('Block explorer utils', () => {
  TEST_CHAINS.map((chain, i) => {
    it(`gets a base url correctly for protocol ${chain.protocol}`, () => {
      expect(getExplorerBaseUrl(chain)).to.equal(EXPECTED_RESULTS[i][0]);
    });
    it(`gets an api url for protocol ${chain.protocol}`, () => {
      expect(getExplorerApiUrl(chain)).to.equal(EXPECTED_RESULTS[i][1]);
    });
    it(`gets a tx url for protocol ${chain.protocol}`, () => {
      expect(getExplorerTxUrl(chain, '0x123')).to.equal(EXPECTED_RESULTS[i][2]);
    });
    it(`gets an address url for protocol ${chain.protocol}`, () => {
      expect(getExplorerAddressUrl(chain, '0x123')).to.equal(
        EXPECTED_RESULTS[i][3],
      );
    });
  });

  describe('Edge cases', () => {
    const emptyChain = {
      protocol: ProtocolType.Ethereum,
      name: 'empty',
      domainId: 1,
      chainId: 1,
      rpcUrls: [{ http: 'https://empty.test' }],
    };

    const chainWithoutApi = {
      protocol: ProtocolType.Ethereum,
      name: 'noapi',
      chainId: 1,
      domainId: 1,
      rpcUrls: [{ http: 'https://noapi.test' }],
      blockExplorers: [
        {
          name: 'test',
          url: 'https://test.com',
          apiUrl: '',
        },
      ],
    };

    it('handles chain without block explorers', () => {
      expect(getExplorerBaseUrl(emptyChain)).to.be.null;
      expect(getExplorerApi(emptyChain)).to.be.null;
      expect(getExplorerTxUrl(emptyChain, '0x123')).to.be.null;
      expect(getExplorerAddressUrl(emptyChain, '0x123')).to.be.null;
    });

    it('handles chain without api url', () => {
      expect(getExplorerBaseUrl(chainWithoutApi)).to.equal('https://test.com/');
      expect(getExplorerApi(chainWithoutApi)).to.be.null;
    });
  });

  describe('Multiple block explorers', () => {
    const multiExplorerChain = {
      protocol: ProtocolType.Ethereum,
      name: 'multi',
      domainId: 1,
      chainId: 1,
      rpcUrls: [{ http: 'https://multi.test' }],
      blockExplorers: [
        {
          name: 'first',
          url: 'https://first.com',
          apiUrl: 'https://api.first.com',
          apiKey: 'key1',
        },
        {
          name: 'second',
          url: 'https://second.com',
          apiUrl: 'https://api.second.com',
          apiKey: 'key2',
        },
      ],
    };

    it('uses correct explorer by index', () => {
      expect(getExplorerBaseUrl(multiExplorerChain, 1)).to.equal(
        'https://second.com/',
      );
      expect(getExplorerApiUrl(multiExplorerChain, 1)).to.equal(
        'https://api.second.com/?apikey=key2',
      );
    });
  });

  describe('Special chain names with different common paths', () => {
    const nautilusChain = {
      protocol: ProtocolType.Ethereum,
      name: 'nautilus',
      chainId: 1,
      domainId: 1,
      rpcUrls: [{ http: 'https://nautilus.test' }],
      blockExplorers: [
        {
          name: 'nautilus',
          url: 'https://nautilus.com',
          apiUrl: 'https://api.nautilus.com',
        },
      ],
    };

    it('uses correct transaction path for special chains', () => {
      expect(getExplorerTxUrl(nautilusChain, '0x123')).to.equal(
        'https://nautilus.com/transaction/0x123',
      );
    });
  });

  describe('URL handling', () => {
    const chainWithTrailingSlash = {
      protocol: ProtocolType.Ethereum,
      name: 'test',
      domainId: 1,
      chainId: 1,
      rpcUrls: [{ http: 'https://test.chain' }],
      blockExplorers: [
        {
          name: 'test',
          url: 'https://test.com/',
          apiUrl: 'https://api.test.com',
        },
      ],
    };

    it('handles trailing slashes correctly', () => {
      expect(getExplorerTxUrl(chainWithTrailingSlash, '0x123')).to.equal(
        'https://test.com/tx/0x123',
      );
    });
  });
});
