import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  IsmConfig,
  ismArtifactToDerivedConfig,
  ismConfigToArtifact,
} from '@hyperlane-xyz/provider-sdk/ism';
import { assert } from '@hyperlane-xyz/utils';

import { IsmReader } from './generic-ism.js';

const chainLookup: ChainLookup = {
  getChainMetadata: () => ({
    name: 'ethereum',
    chainId: 1,
    domainId: 1,
    protocol: ProtocolType.Ethereum,
  }),
  getChainName: (domain) => (domain === 1 ? 'ethereum' : null),
  getDomainId: (chain) => (chain === 'ethereum' ? 1 : null),
  getKnownChainNames: () => ['ethereum'],
};

const reference = (address: string) => ({
  artifactState: ArtifactState.UNDERIVED,
  deployed: { address },
});

function fixture() {
  const artifacts: Record<string, DeployedRawIsmArtifact> = {
    aggregation: {
      artifactState: ArtifactState.DEPLOYED,
      deployed: { address: 'aggregation' },
      config: {
        type: 'staticAggregationIsm',
        threshold: 2,
        modules: [reference('routing'), reference('pausable')],
      },
    },
    routing: {
      artifactState: ArtifactState.DEPLOYED,
      deployed: { address: 'routing' },
      config: {
        type: 'domainRoutingIsm',
        owner: 'router-owner',
        domains: { 1: reference('multisig') },
      },
    },
    multisig: {
      artifactState: ArtifactState.DEPLOYED,
      deployed: { address: 'multisig' },
      config: {
        type: 'messageIdMultisigIsm',
        threshold: 2,
        validators: ['validator1', 'validator2', 'validator3'],
      },
    },
    pausable: {
      artifactState: ArtifactState.DEPLOYED,
      deployed: { address: 'pausable' },
      config: { type: 'pausableIsm', owner: 'pauser', paused: false },
    },
  };
  const reads: string[] = [];
  const manager: IRawIsmArtifactManager = {
    readIsm: async (address) => {
      reads.push(address);
      const artifact = artifacts[address];
      assert(artifact, `Unsupported ISM ${address}`);
      return artifact;
    },
    createReader: () => {
      throw new Error('Unexpected typed reader');
    },
    createWriter: () => {
      throw new Error('Unexpected writer');
    },
  };
  return { artifacts, reads, reader: new IsmReader(manager, chainLookup) };
}

describe('IsmReader aggregation', () => {
  it('expands the Starknet aggregation → routing → multisig and pausable tree', async () => {
    const { reader, reads } = fixture();
    expect(await reader.deriveIsmConfig('aggregation')).to.deep.equal({
      type: 'staticAggregationIsm',
      address: 'aggregation',
      threshold: 2,
      modules: [
        {
          type: 'domainRoutingIsm',
          address: 'routing',
          owner: 'router-owner',
          domains: {
            ethereum: {
              type: 'messageIdMultisigIsm',
              address: 'multisig',
              threshold: 2,
              validators: ['validator1', 'validator2', 'validator3'],
            },
          },
        },
        {
          type: 'pausableIsm',
          address: 'pausable',
          owner: 'pauser',
          paused: false,
        },
      ],
    });
    expect(reads).to.deep.equal([
      'aggregation',
      'routing',
      'multisig',
      'pausable',
    ]);
  });

  it('propagates unsupported children instead of partially reporting a tree', async () => {
    const { reader, artifacts } = fixture();
    delete artifacts.pausable;
    const result = await reader
      .read('aggregation')
      .catch((error: unknown) => error);
    expect(String(result)).to.match(/Unsupported ISM pausable/);
  });

  it('converts nested aggregation config references without losing their addresses', () => {
    const config: IsmConfig = {
      type: 'staticAggregationIsm',
      threshold: 1,
      modules: ['existing-module'],
    };
    const artifact = ismConfigToArtifact(config, chainLookup);
    expect(
      ismArtifactToDerivedConfig(
        {
          ...artifact,
          artifactState: ArtifactState.DEPLOYED,
          deployed: { address: 'root' },
        },
        chainLookup,
      ),
    ).to.deep.equal({ ...config, address: 'root' });
  });

  it('rejects a NEW aggregation child when deriving deployed configuration', () => {
    const artifact = ismConfigToArtifact(
      {
        type: 'staticAggregationIsm',
        threshold: 1,
        modules: [{ type: 'testIsm' }],
      },
      chainLookup,
    );
    expect(() =>
      ismArtifactToDerivedConfig(
        {
          ...artifact,
          artifactState: ArtifactState.DEPLOYED,
          deployed: { address: 'root' },
        },
        chainLookup,
      ),
    ).to.throw(/nested ISM is NEW/);
  });
});
