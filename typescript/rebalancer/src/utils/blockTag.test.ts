import { expect } from 'chai';
import sinon from 'sinon';

import { type ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { getConfirmedBlockTag } from './blockTag.js';

describe('getConfirmedBlockTag', () => {
  let multiProvider: any;

  beforeEach(() => {
    multiProvider = {
      getChainMetadata: sinon.stub(),
      getEthersV5Provider: sinon.stub(),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return undefined for Tron chain with string reorgPeriod', async () => {
    const metadata: Partial<ChainMetadata> = {
      protocol: ProtocolType.Ethereum,
      technicalStack: 'tron' as any,
      blocks: {
        confirmations: 1,
        reorgPeriod: 'finalized',
      },
    };

    multiProvider.getChainMetadata.returns(metadata as ChainMetadata);

    const result = await getConfirmedBlockTag(multiProvider, 'tron');

    expect(result).to.be.undefined;
  });

  it('should return block number for Tron chain with numeric reorgPeriod', async () => {
    const metadata: Partial<ChainMetadata> = {
      protocol: ProtocolType.Ethereum,
      technicalStack: 'tron' as any,
      blocks: {
        confirmations: 1,
        reorgPeriod: 1,
      },
    };

    const mockProvider = {
      getBlockNumber: sinon.stub().resolves(1000),
    };

    multiProvider.getChainMetadata.returns(metadata as ChainMetadata);
    multiProvider.getEthersV5Provider.returns(mockProvider as any);

    const result = await getConfirmedBlockTag(multiProvider, 'tron');

    expect(result).to.equal(999);
  });

  it('should return string tag for non-Tron EVM chain with string reorgPeriod', async () => {
    const metadata: Partial<ChainMetadata> = {
      protocol: ProtocolType.Ethereum,
      technicalStack: 'other' as any,
      blocks: {
        confirmations: 1,
        reorgPeriod: 'finalized',
      },
    };

    multiProvider.getChainMetadata.returns(metadata as ChainMetadata);

    const result = await getConfirmedBlockTag(multiProvider, 'ethereum');

    expect(result).to.equal('finalized');
  });

  it('should return undefined for non-EVM chains', async () => {
    const metadata: Partial<ChainMetadata> = {
      protocol: ProtocolType.Cosmos,
      blocks: {
        confirmations: 1,
        reorgPeriod: 'finalized',
      },
    };

    multiProvider.getChainMetadata.returns(metadata as ChainMetadata);

    const result = await getConfirmedBlockTag(multiProvider, 'cosmos-chain');

    expect(result).to.be.undefined;
  });

  it('should return block number for EVM chain with numeric reorgPeriod', async () => {
    const metadata: Partial<ChainMetadata> = {
      protocol: ProtocolType.Ethereum,
      technicalStack: 'other' as any,
      blocks: {
        confirmations: 1,
        reorgPeriod: 10,
      },
    };

    const mockProvider = {
      getBlockNumber: sinon.stub().resolves(5000),
    };

    multiProvider.getChainMetadata.returns(metadata as ChainMetadata);
    multiProvider.getEthersV5Provider.returns(mockProvider as any);

    const result = await getConfirmedBlockTag(multiProvider, 'ethereum');

    expect(result).to.equal(4990);
  });

  it('should use default reorgPeriod of 32 when not specified', async () => {
    const metadata: Partial<ChainMetadata> = {
      protocol: ProtocolType.Ethereum,
      technicalStack: 'other' as any,
      blocks: {
        confirmations: 1,
      },
    };

    const mockProvider = {
      getBlockNumber: sinon.stub().resolves(1000),
    };

    multiProvider.getChainMetadata.returns(metadata as ChainMetadata);
    multiProvider.getEthersV5Provider.returns(mockProvider as any);

    const result = await getConfirmedBlockTag(multiProvider, 'ethereum');

    expect(result).to.equal(968); // 1000 - 32
  });
});
