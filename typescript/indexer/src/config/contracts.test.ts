import { expect } from 'chai';

import type { IndexerChainConfig } from './chains.js';
import {
  type ContractAddresses,
  buildIgpContractConfig,
  buildMailboxContractConfig,
  buildMerkleTreeHookContractConfig,
} from './contracts.js';

describe('contracts', () => {
  const mockAbi = [{ name: 'test', type: 'function' }];

  const mockChains: IndexerChainConfig[] = [
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
      startBlock: 200,
      isTestnet: false,
    },
    {
      name: 'optimism',
      chainId: 10,
      domainId: 10,
      rpcUrl: 'https://opt.rpc',
      isTestnet: false,
    },
  ];

  const mockAddresses: Record<string, ContractAddresses> = {
    ethereum: {
      mailbox: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      interchainGasPaymaster:
        '0x2222222222222222222222222222222222222222' as `0x${string}`,
      merkleTreeHook:
        '0x3333333333333333333333333333333333333333' as `0x${string}`,
    },
    arbitrum: {
      mailbox: '0x4444444444444444444444444444444444444444' as `0x${string}`,
      // No IGP or MerkleTreeHook
    },
    optimism: {
      mailbox: '0x5555555555555555555555555555555555555555' as `0x${string}`,
      interchainGasPaymaster:
        '0x6666666666666666666666666666666666666666' as `0x${string}`,
      // No MerkleTreeHook
    },
  };

  describe('buildMailboxContractConfig', () => {
    it('builds config for all chains with mailbox addresses', () => {
      const config = buildMailboxContractConfig(
        mockChains,
        mockAddresses,
        mockAbi,
      );

      expect(config.abi).to.equal(mockAbi);
      expect(Object.keys(config.chain)).to.have.length(3);
      expect(config.chain.ethereum.address).to.equal(
        '0x1111111111111111111111111111111111111111',
      );
      expect(config.chain.ethereum.startBlock).to.equal(100);
      expect(config.chain.ethereum.includeTransactionReceipts).to.be.true;
    });

    it('handles chains without startBlock', () => {
      const config = buildMailboxContractConfig(
        mockChains,
        mockAddresses,
        mockAbi,
      );

      expect(config.chain.optimism.startBlock).to.be.undefined;
    });

    it('skips chains without mailbox address', () => {
      const addressesWithMissing = {
        ...mockAddresses,
        arbitrum: {} as ContractAddresses, // No mailbox
      };

      const config = buildMailboxContractConfig(
        mockChains,
        addressesWithMissing,
        mockAbi,
      );

      expect(Object.keys(config.chain)).to.have.length(2);
      expect(config.chain.arbitrum).to.be.undefined;
    });

    it('skips chains not in addresses map', () => {
      const partialAddresses = {
        ethereum: mockAddresses.ethereum,
      };

      const config = buildMailboxContractConfig(
        mockChains,
        partialAddresses,
        mockAbi,
      );

      expect(Object.keys(config.chain)).to.have.length(1);
      expect(config.chain.ethereum).to.exist;
    });
  });

  describe('buildIgpContractConfig', () => {
    it('builds config only for chains with IGP addresses', () => {
      const config = buildIgpContractConfig(mockChains, mockAddresses, mockAbi);

      expect(config.abi).to.equal(mockAbi);
      expect(Object.keys(config.chain)).to.have.length(2);
      expect(config.chain.ethereum.address).to.equal(
        '0x2222222222222222222222222222222222222222',
      );
      expect(config.chain.optimism.address).to.equal(
        '0x6666666666666666666666666666666666666666',
      );
    });

    it('skips chains without IGP address', () => {
      const config = buildIgpContractConfig(mockChains, mockAddresses, mockAbi);

      expect(config.chain.arbitrum).to.be.undefined;
    });

    it('includes startBlock when present', () => {
      const config = buildIgpContractConfig(mockChains, mockAddresses, mockAbi);

      expect(config.chain.ethereum.startBlock).to.equal(100);
      expect(config.chain.optimism.startBlock).to.be.undefined;
    });

    it('returns empty chain config when no IGP addresses', () => {
      const noIgpAddresses: Record<string, ContractAddresses> = {
        ethereum: { mailbox: '0x1111111111111111111111111111111111111111' },
      };

      const config = buildIgpContractConfig(
        mockChains,
        noIgpAddresses,
        mockAbi,
      );

      expect(Object.keys(config.chain)).to.have.length(0);
    });
  });

  describe('buildMerkleTreeHookContractConfig', () => {
    it('builds config only for chains with MerkleTreeHook addresses', () => {
      const config = buildMerkleTreeHookContractConfig(
        mockChains,
        mockAddresses,
        mockAbi,
      );

      expect(config.abi).to.equal(mockAbi);
      expect(Object.keys(config.chain)).to.have.length(1);
      expect(config.chain.ethereum.address).to.equal(
        '0x3333333333333333333333333333333333333333',
      );
    });

    it('skips chains without MerkleTreeHook address', () => {
      const config = buildMerkleTreeHookContractConfig(
        mockChains,
        mockAddresses,
        mockAbi,
      );

      expect(config.chain.arbitrum).to.be.undefined;
      expect(config.chain.optimism).to.be.undefined;
    });

    it('sets includeTransactionReceipts to true', () => {
      const config = buildMerkleTreeHookContractConfig(
        mockChains,
        mockAddresses,
        mockAbi,
      );

      expect(config.chain.ethereum.includeTransactionReceipts).to.be.true;
    });
  });
});
