import { expect } from 'chai';
import sinon from 'sinon';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactComposition,
  ArtifactDeployed,
  ArtifactState,
  ConfigOnChain,
  WithCompositionVariant,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  MultisigIsmConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { RoutingIsmWriter } from './routing-ism.js';

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

interface ArtifactManagerMockOptions {
  routingComposition: ArtifactComposition;
  routingCreateResult?: unknown;
  routingUpdateResult?: AnnotatedTx[];
  multisigCreateResult?: [DeployedIsmArtifact, TxReceipt[]];
  multisigUpdateResult?: AnnotatedTx[];
}

function buildArtifactManager(opts: ArtifactManagerMockOptions) {
  const routingCreate = sinon
    .stub()
    .resolves(opts.routingCreateResult ?? defaultRoutingDeployed());
  const routingUpdate = sinon.stub().resolves(opts.routingUpdateResult ?? []);
  const multisigCreate = sinon.stub().resolves(
    opts.multisigCreateResult ?? [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: childMultisigConfig,
        deployed: { address: childAddress },
      },
      [],
    ],
  );
  const multisigUpdate = sinon.stub().resolves(opts.multisigUpdateResult ?? []);

  const createWriter = sinon.stub().callsFake((type: AltVM.IsmType) => {
    if (type === AltVM.IsmType.ROUTING) {
      return {
        composition: opts.routingComposition,
        create: routingCreate,
        update: routingUpdate,
        read: sinon.stub(),
      };
    }
    return {
      composition: ArtifactComposition.ORCHESTRATED,
      create: multisigCreate,
      update: multisigUpdate,
      read: sinon.stub(),
    };
  });

  const artifactManager: IRawIsmArtifactManager = {
    createReader: sinon.stub(),
    createWriter,
    readIsm: sinon.stub(),
  };

  return {
    artifactManager,
    routingCreate,
    routingUpdate,
    multisigCreate,
    multisigUpdate,
    createWriter,
  };
}

function defaultRoutingDeployed(): [DeployedIsmArtifact, TxReceipt[]] {
  return [
    {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
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
    },
    [],
  ];
}

type OrchestratedRoutingConfig = WithCompositionVariant<
  RoutingIsmArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

function buildOrchestratedNewConfig(): OrchestratedRoutingConfig {
  return {
    composition: ArtifactComposition.ORCHESTRATED,
    type: 'domainRoutingIsm',
    owner,
    domains: {
      [domainId]: {
        artifactState: ArtifactState.NEW,
        config: childMultisigConfig,
      },
    },
  };
}

type DeployedOrchestratedRoutingIsmArtifact = ArtifactDeployed<
  ConfigOnChain<
    WithCompositionVariant<
      RoutingIsmArtifactConfig,
      typeof ArtifactComposition.ORCHESTRATED
    >,
    DeployedIsmAddress
  >,
  DeployedIsmAddress
>;

function buildOrchestratedDeployedArtifact(): DeployedOrchestratedRoutingIsmArtifact {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      composition: ArtifactComposition.ORCHESTRATED,
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

const signer = {} as AltVM.ISigner<AnnotatedTx, TxReceipt>;

describe('RoutingIsmWriter', () => {
  describe('create', () => {
    it('orchestrated raw writer + orchestrated config: dispatches per-child writer + parent create', async () => {
      const mocks = buildArtifactManager({
        routingComposition: ArtifactComposition.ORCHESTRATED,
      });
      const writer = new RoutingIsmWriter(
        mocks.artifactManager,
        chainLookup,
        signer,
      );

      const config = buildOrchestratedNewConfig();
      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config,
      });

      expect(mocks.multisigCreate.calledOnce).to.equal(true);
      expect(mocks.routingCreate.calledOnce).to.equal(true);
      expect(deployed.deployed.address).to.equal(routingAddress);
    });

    it('embedded raw writer + orchestrated config: throws cross-mode mismatch naming both modes', async () => {
      const mocks = buildArtifactManager({
        routingComposition: ArtifactComposition.EMBEDDED,
      });
      const writer = new RoutingIsmWriter(
        mocks.artifactManager,
        chainLookup,
        signer,
      );

      try {
        await writer.create({
          artifactState: ArtifactState.NEW,
          config: buildOrchestratedNewConfig(),
        });
        expect.fail('Expected cross-mode mismatch error');
      } catch (err) {
        expect(err).to.be.instanceOf(Error);
        if (!(err instanceof Error)) throw err;
        expect(err.message).to.include(ArtifactComposition.ORCHESTRATED);
        expect(err.message).to.include(ArtifactComposition.EMBEDDED);
      }

      expect(mocks.routingCreate.called).to.equal(false);
      expect(mocks.multisigCreate.called).to.equal(false);
    });
  });

  describe('update', () => {
    it('orchestrated raw writer + orchestrated config: dispatches per-child update + parent update', async () => {
      const childUpdateTx: AnnotatedTx = { annotation: 'multisig-update' };
      const parentUpdateTx: AnnotatedTx = { annotation: 'routing-update' };
      const mocks = buildArtifactManager({
        routingComposition: ArtifactComposition.ORCHESTRATED,
        routingUpdateResult: [parentUpdateTx],
        multisigUpdateResult: [childUpdateTx],
      });
      const writer = new RoutingIsmWriter(
        mocks.artifactManager,
        chainLookup,
        signer,
      );

      const txs = await writer.update(buildOrchestratedDeployedArtifact());

      expect(mocks.multisigUpdate.calledOnce).to.equal(true);
      expect(mocks.routingUpdate.calledOnce).to.equal(true);
      expect(txs).to.deep.equal([childUpdateTx, parentUpdateTx]);
    });

    it('embedded raw writer + orchestrated config: throws cross-mode mismatch naming both modes', async () => {
      const mocks = buildArtifactManager({
        routingComposition: ArtifactComposition.EMBEDDED,
      });
      const writer = new RoutingIsmWriter(
        mocks.artifactManager,
        chainLookup,
        signer,
      );

      try {
        await writer.update(buildOrchestratedDeployedArtifact());
        expect.fail('Expected cross-mode mismatch error');
      } catch (err) {
        expect(err).to.be.instanceOf(Error);
        if (!(err instanceof Error)) throw err;
        expect(err.message).to.include(ArtifactComposition.ORCHESTRATED);
        expect(err.message).to.include(ArtifactComposition.EMBEDDED);
      }

      expect(mocks.routingUpdate.called).to.equal(false);
      expect(mocks.multisigUpdate.called).to.equal(false);
    });
  });
});
