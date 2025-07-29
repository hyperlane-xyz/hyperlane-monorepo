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
import { ExplorerFamily } from './chainMetadataTypes.js';

const TEST_CHAINS = [
  test1,
  testCosmosChain,
  testSealevelChain,
  testStarknetChain,
];
const EXPECTED_RESULTS = [
  [
    'https://etherscan.io/',
    'https://api.etherscan.io/v2/api?chainid=9913371&apikey=fakekey',
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

  describe('Etherscan V2 URL conversion', () => {
    const etherscanV1Chain = {
      protocol: ProtocolType.Ethereum,
      name: 'ethereum',
      chainId: 1,
      domainId: 1,
      rpcUrls: [{ http: 'https://ethereum.test' }],
      blockExplorers: [
        {
          name: 'Etherscan',
          url: 'https://etherscan.io',
          apiUrl: 'https://api.etherscan.io/api',
          apiKey: 'testkey',
          family: ExplorerFamily.Etherscan,
        },
      ],
    };

    const polygonScanChain = {
      protocol: ProtocolType.Ethereum,
      name: 'polygon',
      chainId: 137,
      domainId: 137,
      rpcUrls: [{ http: 'https://polygon.test' }],
      blockExplorers: [
        {
          name: 'PolygonScan',
          url: 'https://polygonscan.com',
          apiUrl: 'https://api.polygonscan.com/api',
          apiKey: 'polygonkey',
          family: ExplorerFamily.Etherscan,
        },
      ],
    };

    const bscScanChain = {
      protocol: ProtocolType.Ethereum,
      name: 'bsc',
      chainId: 56,
      domainId: 56,
      rpcUrls: [{ http: 'https://bsc.test' }],
      blockExplorers: [
        {
          name: 'BscScan',
          url: 'https://bscscan.com',
          apiUrl: 'https://api.bscscan.com/api',
          apiKey: 'bsckey',
          family: ExplorerFamily.Etherscan,
        },
      ],
    };

    const alreadyV2Chain = {
      protocol: ProtocolType.Ethereum,
      name: 'ethereum',
      chainId: 1,
      domainId: 1,
      rpcUrls: [{ http: 'https://ethereum.test' }],
      blockExplorers: [
        {
          name: 'Etherscan',
          url: 'https://etherscan.io',
          apiUrl: 'https://api.etherscan.io/v2/api',
          apiKey: 'testkey',
          family: ExplorerFamily.Etherscan,
        },
      ],
    };

    const nonScanChain = {
      protocol: ProtocolType.Ethereum,
      name: 'custom',
      chainId: 999,
      domainId: 999,
      rpcUrls: [{ http: 'https://custom.test' }],
      blockExplorers: [
        {
          name: 'Custom Explorer',
          url: 'https://custom-explorer.com',
          apiUrl: 'https://api.custom-explorer.com/api',
          apiKey: 'customkey',
          family: ExplorerFamily.Other,
        },
      ],
    };

    it('converts Etherscan V1 API to V2 format with chainId', () => {
      const result = getExplorerApi(etherscanV1Chain);
      expect(result).to.deep.equal({
        apiUrl: 'https://api.etherscan.io/v2/api?chainid=1',
        apiKey: 'testkey',
        family: ExplorerFamily.Etherscan,
      });
    });

    it('converts PolygonScan API to V2 format with chainId', () => {
      const result = getExplorerApi(polygonScanChain);
      expect(result).to.deep.equal({
        apiUrl: 'https://api.etherscan.io/v2/api?chainid=137',
        apiKey: 'polygonkey',
        family: ExplorerFamily.Etherscan,
      });
    });

    it('converts BscScan API to V2 format with chainId', () => {
      const result = getExplorerApi(bscScanChain);
      expect(result).to.deep.equal({
        apiUrl: 'https://api.etherscan.io/v2/api?chainid=56',
        apiKey: 'bsckey',
        family: ExplorerFamily.Etherscan,
      });
    });

    it('leaves already V2 URLs unchanged', () => {
      const result = getExplorerApi(alreadyV2Chain);
      expect(result).to.deep.equal({
        apiUrl: 'https://api.etherscan.io/v2/api?chainid=1',
        apiKey: 'testkey',
        family: ExplorerFamily.Etherscan,
      });
    });

    it('leaves non-scan APIs unchanged', () => {
      const result = getExplorerApi(nonScanChain);
      expect(result).to.deep.equal({
        apiUrl: 'https://api.custom-explorer.com/api',
        apiKey: 'customkey',
        family: ExplorerFamily.Other,
      });
    });

    it('handles string chainId conversion', () => {
      const stringChainIdChain = {
        ...etherscanV1Chain,
        chainId: '1',
      };
      const result = getExplorerApi(stringChainIdChain);
      expect(result).to.deep.equal({
        apiUrl: 'https://api.etherscan.io/v2/api?chainid=1',
        apiKey: 'testkey',
        family: ExplorerFamily.Etherscan,
      });
    });

    it('handles missing chainId gracefully', () => {
      const noChainIdChain = {
        ...etherscanV1Chain,
        chainId: 0, // Use 0 instead of undefined to satisfy type requirements
      };
      const result = getExplorerApi(noChainIdChain);
      expect(result).to.deep.equal({
        apiUrl: 'https://api.etherscan.io/v2/api',
        apiKey: 'testkey',
        family: ExplorerFamily.Etherscan,
      });
    });

    it('includes API key in final URL', () => {
      const result = getExplorerApiUrl(etherscanV1Chain);
      expect(result).to.equal(
        'https://api.etherscan.io/v2/api?chainid=1&apikey=testkey',
      );
    });

    it('handles various explorer families', () => {
      const testCases = [
        { family: ExplorerFamily.Etherscan, expected: true },
        { family: ExplorerFamily.Other, expected: false },
      ];

      testCases.forEach(({ family, expected }) => {
        const testChain = {
          ...etherscanV1Chain,
          blockExplorers: [
            {
              ...etherscanV1Chain.blockExplorers[0],
              family,
            },
          ],
        };
        const result = getExplorerApi(testChain);
        if (expected) {
          expect(result?.apiUrl).to.include('api.etherscan.io/v2/api');
        } else {
          expect(result?.apiUrl).to.equal('https://api.etherscan.io/api');
        }
      });
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
