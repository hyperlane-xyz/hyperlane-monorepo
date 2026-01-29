import { expect } from 'chai';
import Sinon from 'sinon';

import {
  ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  DeployedRawIsmArtifact,
  MultisigIsmConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { IsmWriter } from './generic-ism-writer.js';
import {
  IsmWriterTestFixture,
  TEST_ADDRESSES,
  TEST_CONFIGS,
  createIsmWriterTestFixture,
} from './test-fixtures.js';

/**
 * Tests for IsmWriter.update() - the backward-compatible interface.
 *
 * update() delegates to applyUpdate() internally and returns:
 * - Empty array for noop/create actions (caller must check address separately)
 * - Transaction array for update actions
 */
describe('IsmWriter update', () => {
  let fixture: IsmWriterTestFixture;

  beforeEach(async () => {
    fixture = await createIsmWriterTestFixture();
  });

  afterEach(() => {
    Sinon.restore();
  });

  it('type change -> calls create, returns []', async () => {
    const {
      signer,
      chainLookup,
      mockArtifactManager,
      routingCreateSpy,
      routingUpdateSpy,
    } = fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Current ISM is multisig (default), desired is routing
    const desiredArtifact: ArtifactDeployed<
      RoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: 'domainRoutingIsm', owner: '0xOwner', domains: {} },
      deployed: { address: TEST_ADDRESSES.EXISTING_ISM },
    };

    const txs = await ismWriter.update(desiredArtifact);

    expect(txs).to.have.lengthOf(0);
    expect(routingCreateSpy.calledOnce).to.be.true;
    expect(routingUpdateSpy.called).to.be.false;
  });

  it('unchanged immutable config -> no-op, returns []', async () => {
    const {
      signer,
      chainLookup,
      mockArtifactManager,
      multisigCreateSpy,
      multisigUpdateSpy,
    } = fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired matches current (default mock returns this config)
    const artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress> = {
      artifactState: ArtifactState.DEPLOYED,
      config: TEST_CONFIGS.multisig.base,
      deployed: { address: TEST_ADDRESSES.EXISTING_ISM },
    };

    const txs = await ismWriter.update(artifact);

    expect(txs).to.have.lengthOf(0);
    expect(multisigCreateSpy.called).to.be.false;
    expect(multisigUpdateSpy.called).to.be.false;
  });

  it('changed immutable config -> calls create, returns []', async () => {
    const {
      signer,
      chainLookup,
      mockArtifactManager,
      multisigCreateSpy,
      multisigUpdateSpy,
    } = fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired has different validators/threshold than current
    const desiredArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: TEST_CONFIGS.multisig.changed,
      deployed: { address: TEST_ADDRESSES.EXISTING_ISM },
    };

    const txs = await ismWriter.update(desiredArtifact);

    expect(txs).to.have.lengthOf(0);
    expect(multisigCreateSpy.calledOnce).to.be.true;
    expect(multisigUpdateSpy.called).to.be.false;
  });

  it('changed mutable config -> calls update, returns txs', async () => {
    const {
      signer,
      chainLookup,
      mockArtifactManager,
      routingCreateSpy,
      routingUpdateSpy,
    } = fixture;

    // Configure current ISM as routing
    (mockArtifactManager.readIsm as Sinon.SinonStub).resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: TEST_CONFIGS.routing.empty,
      deployed: { address: TEST_ADDRESSES.EXISTING_ISM },
    } satisfies DeployedRawIsmArtifact);

    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired has additional domain
    const desiredArtifact: ArtifactDeployed<
      RoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'domainRoutingIsm',
        owner: '0xOwner',
        domains: {
          1: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: TEST_ADDRESSES.DOMAIN1_ISM },
          },
        },
      },
      deployed: { address: TEST_ADDRESSES.EXISTING_ISM },
    };

    const txs = await ismWriter.update(desiredArtifact);

    expect(txs.length).to.be.greaterThan(0);
    expect(routingUpdateSpy.calledOnce).to.be.true;
    expect(routingCreateSpy.called).to.be.false;
  });
});

/**
 * Tests for IsmWriter.applyUpdate() - the core update method.
 *
 * applyUpdate() returns a result object with:
 * - action: 'noop' | 'create' | 'update'
 * - deployed: The resulting deployed artifact (with correct address)
 * - receipts (for create) or txs (for update)
 */
describe('IsmWriter applyUpdate', () => {
  let fixture: IsmWriterTestFixture;

  beforeEach(async () => {
    fixture = await createIsmWriterTestFixture();
  });

  afterEach(() => {
    Sinon.restore();
  });

  it('type change -> action:create with new address', async () => {
    const { signer, chainLookup, mockArtifactManager, routingCreateSpy } =
      fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Current is multisig (default), desired is routing
    const result = await ismWriter.applyUpdate(TEST_ADDRESSES.EXISTING_ISM, {
      config: TEST_CONFIGS.routing.empty,
    });

    expect(result.action).to.equal('create');
    expect(result.deployed.deployed.address).to.equal(TEST_ADDRESSES.NEW_ISM);
    expect('receipts' in result).to.be.true;
    expect(routingCreateSpy.calledOnce).to.be.true;
  });

  it('unchanged immutable config -> action:noop with same address', async () => {
    const { signer, chainLookup, mockArtifactManager, multisigCreateSpy } =
      fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired matches current (default mock config)
    const result = await ismWriter.applyUpdate(TEST_ADDRESSES.EXISTING_ISM, {
      config: TEST_CONFIGS.multisig.base,
    });

    expect(result.action).to.equal('noop');
    expect(result.deployed.deployed.address).to.equal(
      TEST_ADDRESSES.EXISTING_ISM,
    );
    expect(multisigCreateSpy.called).to.be.false;
  });

  it('changed immutable config -> action:create with new address', async () => {
    const { signer, chainLookup, mockArtifactManager, multisigCreateSpy } =
      fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired differs from current
    const result = await ismWriter.applyUpdate(TEST_ADDRESSES.EXISTING_ISM, {
      config: TEST_CONFIGS.multisig.changed,
    });

    expect(result.action).to.equal('create');
    expect(result.deployed.deployed.address).to.equal(TEST_ADDRESSES.NEW_ISM);
    expect('receipts' in result).to.be.true;
    expect(multisigCreateSpy.calledOnce).to.be.true;
  });

  it('changed mutable config -> action:update with same address and txs', async () => {
    const { signer, chainLookup, mockArtifactManager, routingCreateSpy } =
      fixture;

    // Configure current ISM as routing
    (mockArtifactManager.readIsm as Sinon.SinonStub).resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: TEST_CONFIGS.routing.empty,
      deployed: { address: TEST_ADDRESSES.EXISTING_ISM },
    } satisfies DeployedRawIsmArtifact);

    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired has additional domain
    const result = await ismWriter.applyUpdate(TEST_ADDRESSES.EXISTING_ISM, {
      config: {
        type: 'domainRoutingIsm',
        owner: '0xOwner',
        domains: {
          1: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: TEST_ADDRESSES.DOMAIN1_ISM },
          },
        },
      },
    });

    expect(result.action).to.equal('update');
    expect(result.deployed.deployed.address).to.equal(
      TEST_ADDRESSES.EXISTING_ISM,
    );
    expect('txs' in result).to.be.true;
    if (result.action === 'update') {
      expect(result.txs.length).to.be.greaterThan(0);
    }
    expect(routingCreateSpy.called).to.be.false;
  });
});
