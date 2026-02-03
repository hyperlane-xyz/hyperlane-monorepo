import { expect } from 'chai';

import { type IndexerChainConfig, buildPonderChains } from './chains.js';

describe('chains', () => {
  describe('buildPonderChains', () => {
    it('builds Ponder chain config from indexer configs', () => {
      const chains: IndexerChainConfig[] = [
        {
          name: 'ethereum',
          chainId: 1,
          domainId: 1,
          rpcUrl: 'https://eth.rpc',
          startBlock: 100,
          isTestnet: false,
        },
        {
          name: 'arbitrum',
          chainId: 42161,
          domainId: 42161,
          rpcUrl: 'https://arb.rpc',
          isTestnet: false,
        },
      ];

      const result = buildPonderChains(chains);

      expect(Object.keys(result)).to.have.length(2);
      expect(result.ethereum).to.exist;
      expect(result.ethereum.id).to.equal(1);
      expect(result.arbitrum.id).to.equal(42161);
    });

    it('returns empty object for empty chains array', () => {
      const result = buildPonderChains([]);

      expect(Object.keys(result)).to.have.length(0);
    });

    it('uses chain name as key', () => {
      const chains: IndexerChainConfig[] = [
        {
          name: 'sepolia',
          chainId: 11155111,
          domainId: 11155111,
          rpcUrl: 'https://sepolia.rpc',
          isTestnet: true,
        },
      ];

      const result = buildPonderChains(chains);

      expect(result.sepolia).to.exist;
      expect(result.sepolia.id).to.equal(11155111);
    });

    it('creates rpc transport for each chain', () => {
      const chains: IndexerChainConfig[] = [
        {
          name: 'optimism',
          chainId: 10,
          domainId: 10,
          rpcUrl: 'https://opt.rpc',
          isTestnet: false,
        },
      ];

      const result = buildPonderChains(chains);

      // rpc is a viem http transport function
      expect(result.optimism.rpc).to.exist;
      expect(typeof result.optimism.rpc).to.equal('function');
    });
  });
});
