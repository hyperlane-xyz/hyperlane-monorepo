import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';

import {
  defaultEthersV5ProviderBuilder,
  defaultProviderBuilder,
} from './ethersV5.js';

function metadata(urls: string[]): ChainMetadata {
  return {
    name: 'local',
    chainId: 31337,
    domainId: 31337,
    protocol: ProtocolType.Ethereum,
    rpcUrls: urls.map((http) => ({ http })),
  };
}

describe('ethers v5 provider builder polling', () => {
  for (const [blockTime, expectedInterval] of [
    [0.25, 1000],
    [2, 2000],
    [13, 4000],
    [0, 4000],
  ]) {
    it(`bounds remote polling for a ${blockTime}s block time`, () => {
      const config = metadata(['https://rpc.example.com']);
      config.blocks = { confirmations: 1, estimateBlockTime: blockTime };
      expect(defaultProviderBuilder(config).pollingInterval).to.equal(
        expectedInterval,
      );
    });
  }

  it('uses remote bounds for mixed RPCs with a block-time estimate', () => {
    const config = metadata([
      'http://localhost:8545',
      'https://rpc.example.com',
    ]);
    config.blocks = { confirmations: 1, estimateBlockTime: 0.25 };
    expect(defaultProviderBuilder(config).pollingInterval).to.equal(1000);
  });

  it('prioritizes loopback polling over the block-time estimate', () => {
    const config = metadata(['http://localhost:8545']);
    config.blocks = { confirmations: 1, estimateBlockTime: 13 };
    expect(defaultProviderBuilder(config).pollingInterval).to.equal(100);
  });

  for (const urls of [
    ['http://localhost:8545'],
    ['http://127.0.0.1:8596'],
    ['http://[::1]:8545'],
    ['http://localhost:8545', 'http://127.0.0.1:8596'],
  ]) {
    it(`polls loopback RPCs quickly: ${urls.join(', ')}`, () => {
      // MultiProtocolProvider and MultiProvider use these respective builders.
      expect(
        defaultEthersV5ProviderBuilder(metadata(urls)).provider.pollingInterval,
      ).to.equal(100);
      expect(defaultProviderBuilder(metadata(urls)).pollingInterval).to.equal(
        100,
      );
    });
  }

  for (const urls of [
    ['https://rpc.example.com'],
    ['http://localhost:8545', 'https://rpc.example.com'],
    ['https://localhost.example.com'],
    ['http://192.168.1.1:8545'],
  ]) {
    it(`preserves default polling with remote RPCs: ${urls.join(', ')}`, () => {
      expect(
        defaultEthersV5ProviderBuilder(metadata(urls)).provider.pollingInterval,
      ).to.equal(4000);
    });
  }
});
