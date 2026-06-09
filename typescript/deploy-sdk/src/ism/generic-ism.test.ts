import { expect } from 'chai';
import sinon from 'sinon';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactComposition,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { IsmReader } from './generic-ism.js';

const chainName = 'chain1';
const domainId = 1;

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: (chain) => (chain === chainName ? domainId : null),
  getChainName: (id) => (id === domainId ? chainName : null),
  getKnownChainNames: () => [chainName],
};

const validator1 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const validator2 = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const owner = '0x1111111111111111111111111111111111111111';
const routingAddress = '0x2222222222222222222222222222222222222222';
const childAddress = '0x3333333333333333333333333333333333333333';

const childMultisigConfig: MultisigIsmConfig = {
  type: 'merkleRootMultisigIsm',
  validators: [validator1, validator2],
  threshold: 2,
};

function orchestratedRawRoutingRead(): DeployedRawIsmArtifact {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      composition: ArtifactComposition.ORCHESTRATED,
      type: 'domainRoutingIsm',
      owner,
      domains: {
        [domainId]: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: childAddress },
        },
      },
    },
    deployed: { address: routingAddress },
  };
}

function embeddedRawRoutingRead(): DeployedRawIsmArtifact {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      composition: ArtifactComposition.EMBEDDED,
      type: 'domainRoutingIsm',
      owner,
      domains: {
        [domainId]: {
          artifactState: ArtifactState.DEPLOYED,
          config: childMultisigConfig,
          deployed: { address: childAddress },
        },
      },
    },
    deployed: { address: routingAddress },
  };
}

interface ReaderMockOptions {
  rawRoutingComposition: ArtifactComposition;
  readIsmImpl: (address: string) => Promise<DeployedRawIsmArtifact>;
}

function buildArtifactManager(opts: ReaderMockOptions) {
  const readIsm = sinon.stub().callsFake(opts.readIsmImpl);
  const createReader = sinon.stub().callsFake((type: AltVM.IsmType) => {
    if (type === AltVM.IsmType.ROUTING) {
      return {
        composition: opts.rawRoutingComposition,
        read: sinon.stub(),
      };
    }
    return {
      composition: ArtifactComposition.ORCHESTRATED,
      read: sinon.stub(),
    };
  });

  const artifactManager: IRawIsmArtifactManager = {
    createReader,
    createWriter: sinon.stub(),
    readIsm,
  };

  return { artifactManager, readIsm, createReader };
}

describe('IsmReader.read', () => {
  it('orchestrated raw reader: recurses into UNDERIVED domain children', async () => {
    const childRead: DeployedRawIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: childMultisigConfig,
      deployed: { address: childAddress },
    };
    const mocks = buildArtifactManager({
      rawRoutingComposition: ArtifactComposition.ORCHESTRATED,
      readIsmImpl: async (address: string) => {
        if (address === routingAddress) return orchestratedRawRoutingRead();
        if (address === childAddress) return childRead;
        throw new Error(`Unexpected read for ${address}`);
      },
    });

    const reader = new IsmReader(mocks.artifactManager, chainLookup);
    const result = await reader.read(routingAddress);

    expect(mocks.readIsm.callCount).to.equal(2);
    expect(mocks.readIsm.firstCall.args[0]).to.equal(routingAddress);
    expect(mocks.readIsm.secondCall.args[0]).to.equal(childAddress);

    expect(result.config.type).to.equal('domainRoutingIsm');
    expect(result.deployed.address).to.equal(routingAddress);
  });

  it('embedded raw reader: throws cross-mode mismatch (orchestrated reader cannot expand embedded)', async () => {
    const mocks = buildArtifactManager({
      rawRoutingComposition: ArtifactComposition.EMBEDDED,
      readIsmImpl: async () => embeddedRawRoutingRead(),
    });

    const reader = new IsmReader(mocks.artifactManager, chainLookup);

    try {
      await reader.read(routingAddress);
      expect.fail('Expected cross-mode mismatch error');
    } catch (err) {
      expect(err).to.be.instanceOf(Error);
      if (!(err instanceof Error)) throw err;
      expect(err.message).to.include(ArtifactComposition.ORCHESTRATED);
      expect(err.message).to.include(ArtifactComposition.EMBEDDED);
    }

    // readIsm fires once on the parent; no per-child reads because
    // expandRoutingIsm never runs on the embedded path.
    expect(mocks.readIsm.callCount).to.equal(1);
  });
});
