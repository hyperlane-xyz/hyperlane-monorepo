import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import { ArtifactNew, ArtifactState, isArtifactDeployed } from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  CompositeIsmConfig,
  DeployedIsmArtifact,
  DerivedIsmConfig,
  IsmArtifactConfig,
  altVMIsmTypeToProviderSdkType,
  ismArtifactToDerivedConfig,
  ismConfigToArtifact,
  mergeIsmArtifacts,
} from './ism.js';

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: (chain) => {
    if (chain === 'solanamainnet') return 1399811149;
    if (chain === 'ethereum') return 1;
    return null;
  },
  getChainName: (domainId: number) => {
    if (domainId === 1399811149) return 'solanamainnet';
    if (domainId === 1) return 'ethereum';
    return null;
  },
  getKnownChainNames: () => ['solanamainnet', 'ethereum'],
};

// Real base58 Sealevel pubkeys (not just arbitrary-length placeholder
// strings) so the artifact-conversion round-trip below is meaningful —
// provider-sdk itself does no address format validation, so a regression
// that mangled address bytes wouldn't be caught by fixtures that were never
// valid pubkeys to begin with.
const PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RELAYER = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';
const MAILBOX = 'ComputeBudget111111111111111111111111111111';
const OWNER = 'Vote111111111111111111111111111111111111111';

describe('compositeIsm config <-> artifact conversion', () => {
  it('altVMIsmTypeToProviderSdkType maps COMPOSITE to compositeIsm', () => {
    expect(altVMIsmTypeToProviderSdkType(AltVMIsmType.COMPOSITE)).to.equal(
      'compositeIsm',
    );
  });

  it('converts a nested tree from chain-name to domain-ID keyed domains', () => {
    const config: CompositeIsmConfig = {
      type: 'compositeIsm',
      owner: OWNER,
      root: {
        type: 'aggregation',
        threshold: 2,
        subIsms: [
          { type: 'trustedRelayer', relayer: RELAYER },
          {
            type: 'routing',
            domains: {
              solanamainnet: { type: 'test', accept: true },
            },
          },
          {
            type: 'amountRouting',
            threshold: '1000000',
            lower: { type: 'pausable', paused: false },
            upper: {
              type: 'rateLimited',
              maxCapacity: '86400',
              mailbox: MAILBOX,
            },
          },
        ],
      },
    };

    const artifact = ismConfigToArtifact(config, chainLookup);
    expect(artifact.artifactState).to.equal(ArtifactState.NEW);

    assert(artifact.config.type === 'compositeIsm', 'expected compositeIsm');
    const artifactConfig = artifact.config;
    expect(artifactConfig.type).to.equal('compositeIsm');
    expect(artifactConfig.owner).to.equal(OWNER);
    assert(artifactConfig.root.type === 'aggregation', 'expected aggregation');
    expect(artifactConfig.root.threshold).to.equal(2);

    const [relayerNode, routingNode, amountRoutingNode] =
      artifactConfig.root.subIsms;
    expect(relayerNode).to.deep.equal({
      type: 'trustedRelayer',
      relayer: RELAYER,
    });

    assert(routingNode.type === 'routing', 'expected routing');
    // chain name -> domain ID conversion happened
    expect(routingNode.domains).to.deep.equal({
      1399811149: { type: 'test', accept: true },
    });

    assert(
      amountRoutingNode.type === 'amountRouting',
      'expected amountRouting',
    );
    expect(amountRoutingNode.threshold).to.equal('1000000');
    expect(amountRoutingNode.lower).to.deep.equal({
      type: 'pausable',
      paused: false,
    });
    expect(amountRoutingNode.upper).to.deep.equal({
      type: 'rateLimited',
      maxCapacity: '86400',
      mailbox: MAILBOX,
    });
  });

  it('skips domains for unknown chain names, matching domainRoutingIsm', () => {
    const config: CompositeIsmConfig = {
      type: 'compositeIsm',
      owner: OWNER,
      root: {
        type: 'routing',
        domains: {
          solanamainnet: { type: 'test', accept: true },
          unknownchain: { type: 'test', accept: false },
        },
      },
    };

    const artifact = ismConfigToArtifact(config, chainLookup);
    assert(artifact.config.type === 'compositeIsm', 'expected compositeIsm');
    const artifactConfig = artifact.config;
    assert(artifactConfig.root.type === 'routing', 'expected routing');
    expect(Object.keys(artifactConfig.root.domains ?? {})).to.deep.equal([
      '1399811149',
    ]);
  });

  it('converts domain-ID keyed domains back to chain names and attaches address', () => {
    const deployedArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'compositeIsm',
        owner: OWNER,
        root: {
          type: 'fallbackRouting',
          fallbackIsm: RELAYER,
          domains: {
            1399811149: { type: 'test', accept: true },
          },
        },
      },
      deployed: { address: PROGRAM_ADDRESS },
    };

    const derived = ismArtifactToDerivedConfig(deployedArtifact, chainLookup);
    const expected: DerivedIsmConfig = {
      type: 'compositeIsm',
      owner: OWNER,
      address: PROGRAM_ADDRESS,
      root: {
        type: 'fallbackRouting',
        fallbackIsm: RELAYER,
        domains: {
          solanamainnet: { type: 'test', accept: true },
        },
      },
    };
    expect(derived).to.deep.equal(expected);
  });

  it('skips domains for unknown domain IDs when deriving config', () => {
    const deployedArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'compositeIsm',
        owner: OWNER,
        root: {
          type: 'routing',
          domains: {
            1399811149: { type: 'test', accept: true },
            999999999: { type: 'test', accept: false },
          },
        },
      },
      deployed: { address: PROGRAM_ADDRESS },
    };

    const derived = ismArtifactToDerivedConfig(deployedArtifact, chainLookup);
    assert(
      derived.type === 'compositeIsm' && derived.root.type === 'routing',
      'expected compositeIsm/routing',
    );
    expect(Object.keys(derived.root.domains ?? {})).to.deep.equal([
      'solanamainnet',
    ]);
  });

  it('does not recurse when merging — treats compositeIsm as self-diffing', () => {
    const currentArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'compositeIsm',
        owner: OWNER,
        root: { type: 'test', accept: true },
      },
      deployed: { address: PROGRAM_ADDRESS },
    };

    const expectedArtifact: ArtifactNew<IsmArtifactConfig> = {
      artifactState: ArtifactState.NEW,
      config: {
        type: 'compositeIsm',
        owner: OWNER,
        // Different tree — mergeIsmArtifacts should NOT try to reconcile
        // this itself; it just passes the expected config through, leaving
        // the actual diffing to SvmCompositeIsmWriter.update().
        root: { type: 'pausable', paused: true },
      },
    };

    const result = mergeIsmArtifacts(currentArtifact, expectedArtifact);
    expect(isArtifactDeployed(result)).to.be.true;
    assert(isArtifactDeployed(result), 'expected DEPLOYED artifact');
    expect(result.config).to.deep.equal(expectedArtifact.config);
    expect(result.deployed).to.deep.equal({ address: PROGRAM_ADDRESS });
  });

  it('deploys new when type changes away from compositeIsm', () => {
    const currentArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'compositeIsm',
        owner: OWNER,
        root: { type: 'test', accept: true },
      },
      deployed: { address: PROGRAM_ADDRESS },
    };

    const expectedArtifact: ArtifactNew<IsmArtifactConfig> = {
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    };

    const result = mergeIsmArtifacts(currentArtifact, expectedArtifact);
    expect(result.artifactState).to.equal(ArtifactState.NEW);
    expect(result.config).to.deep.equal({ type: 'testIsm' });
  });
});
