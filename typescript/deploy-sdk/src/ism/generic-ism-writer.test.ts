import { expect } from 'chai';
import Sinon from 'sinon';

import { AltVM, MockSigner, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  MultisigIsmConfig,
  RawIsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { IsmWriter } from './generic-ism-writer.js';

// Test addresses used across all test suites
const EXISTING_ISM_ADDRESS = '0xExistingIsm';
const NEW_ISM_ADDRESS = '0xNewIsm';

/**
 * Shared test fixture for IsmWriter tests.
 * Creates mock artifact manager, writers, and spies for tracking method calls.
 */
interface IsmWriterTestFixture {
  signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  chainLookup: ChainLookup;
  mockArtifactManager: IRawIsmArtifactManager;
  multisigCreateSpy: Sinon.SinonStub;
  multisigUpdateSpy: Sinon.SinonStub;
  routingCreateSpy: Sinon.SinonStub;
  routingUpdateSpy: Sinon.SinonStub;
}

/**
 * Creates a test fixture with mock artifact manager and spies.
 * Default current ISM is a multisig - use mockArtifactManager.readIsm stub to change.
 */
async function createTestFixture(): Promise<IsmWriterTestFixture> {
  const signer = await MockSigner.connectWithSigner();

  const chainLookup: ChainLookup = {
    getChainMetadata: () => ({
      name: 'test',
      domainId: 1,
      chainId: 1,
      protocol: ProtocolType.Cosmos,
    }),
    getChainName: (domainId: number) =>
      domainId === 1 ? 'test' : domainId === 2 ? 'test2' : null,
    getDomainId: (chain: string | number) => {
      if (typeof chain === 'number') return chain;
      return chain === 'test' ? 1 : chain === 'test2' ? 2 : null;
    },
    getKnownChainNames: () => ['test', 'test2'],
  };

  // Create mock multisig writer (immutable ISM type)
  const multisigCreateSpy = Sinon.stub().resolves([
    {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'messageIdMultisigIsm',
        validators: ['0xValidator1', '0xValidator2'],
        threshold: 2,
      },
      deployed: { address: NEW_ISM_ADDRESS },
    } satisfies DeployedRawIsmArtifact,
    [] as TxReceipt[],
  ]);
  const multisigUpdateSpy = Sinon.stub().resolves([] as AnnotatedTx[]);

  const mockMultisigWriter: ArtifactWriter<
    MultisigIsmConfig,
    DeployedIsmAddress
  > = {
    create: multisigCreateSpy,
    update: multisigUpdateSpy,
    read: Sinon.stub().resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'messageIdMultisigIsm',
        validators: ['0xValidator1'],
        threshold: 1,
      },
      deployed: { address: EXISTING_ISM_ADDRESS },
    } satisfies DeployedRawIsmArtifact),
  };

  // Create mock routing writer (mutable ISM type)
  const routingCreateSpy = Sinon.stub().resolves([
    {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'domainRoutingIsm',
        owner: '0xOwner',
        domains: {},
      },
      deployed: { address: NEW_ISM_ADDRESS },
    } satisfies DeployedRawIsmArtifact,
    [] as TxReceipt[],
  ]);
  const routingUpdateSpy = Sinon.stub().resolves([
    { annotation: 'mock routing update tx' } as AnnotatedTx,
  ]);

  const mockRoutingWriter: ArtifactWriter<
    RawRoutingIsmArtifactConfig,
    DeployedIsmAddress
  > = {
    create: routingCreateSpy,
    update: routingUpdateSpy,
    read: Sinon.stub().resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'domainRoutingIsm',
        owner: '0xOwner',
        domains: {},
      },
      deployed: { address: EXISTING_ISM_ADDRESS },
    } satisfies DeployedRawIsmArtifact),
  };

  // Create mock artifact manager - default returns multisig ISM
  const mockArtifactManager: IRawIsmArtifactManager = {
    readIsm: Sinon.stub().resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'messageIdMultisigIsm',
        validators: ['0xValidator1'],
        threshold: 1,
      },
      deployed: { address: EXISTING_ISM_ADDRESS },
    } satisfies DeployedRawIsmArtifact),

    createReader: ((type: string) => {
      if (type === AltVM.IsmType.ROUTING) {
        return mockRoutingWriter as ArtifactReader<
          RawIsmArtifactConfig,
          DeployedIsmAddress
        >;
      }
      return mockMultisigWriter as ArtifactReader<
        RawIsmArtifactConfig,
        DeployedIsmAddress
      >;
    }) as IRawIsmArtifactManager['createReader'],

    createWriter: ((type: string, _signer: unknown) => {
      if (type === AltVM.IsmType.ROUTING) {
        return mockRoutingWriter as ArtifactWriter<
          RawIsmArtifactConfig,
          DeployedIsmAddress
        >;
      }
      return mockMultisigWriter as ArtifactWriter<
        RawIsmArtifactConfig,
        DeployedIsmAddress
      >;
    }) as IRawIsmArtifactManager['createWriter'],
  } satisfies Partial<IRawIsmArtifactManager> as IRawIsmArtifactManager;

  return {
    signer,
    chainLookup,
    mockArtifactManager,
    multisigCreateSpy,
    multisigUpdateSpy,
    routingCreateSpy,
    routingUpdateSpy,
  };
}

/**
 * Tests for IsmWriter.update() - the backward-compatible interface.
 *
 * update() delegates to applyUpdate() internally and returns:
 * - Empty array for noop/create actions (caller must check address separately)
 * - Transaction array for update actions
 *
 * These tests verify correct delegation to internal methods.
 */
describe('IsmWriter update', () => {
  let fixture: IsmWriterTestFixture;

  beforeEach(async () => {
    fixture = await createTestFixture();
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
      deployed: { address: EXISTING_ISM_ADDRESS },
    };

    const txs = await ismWriter.update(desiredArtifact);

    expect(txs).to.have.lengthOf(0); // update() returns [] for create actions
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
      config: {
        type: 'messageIdMultisigIsm',
        validators: ['0xValidator1'],
        threshold: 1,
      },
      deployed: { address: EXISTING_ISM_ADDRESS },
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
      config: {
        type: 'messageIdMultisigIsm',
        validators: ['0xValidator1', '0xValidator2'],
        threshold: 2,
      },
      deployed: { address: EXISTING_ISM_ADDRESS },
    };

    const txs = await ismWriter.update(desiredArtifact);

    expect(txs).to.have.lengthOf(0); // update() returns [] for create actions
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
      config: { type: 'domainRoutingIsm', owner: '0xOwner', domains: {} },
      deployed: { address: EXISTING_ISM_ADDRESS },
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
            deployed: { address: '0xDomainIsm1' },
          },
        },
      },
      deployed: { address: EXISTING_ISM_ADDRESS },
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
 *
 * This method should be used when the caller needs to know the resulting address,
 * e.g., when updating nested ISMs in a routing ISM.
 */
describe('IsmWriter applyUpdate', () => {
  let fixture: IsmWriterTestFixture;

  beforeEach(async () => {
    fixture = await createTestFixture();
  });

  afterEach(() => {
    Sinon.restore();
  });

  it('type change -> action:create with new address', async () => {
    const { signer, chainLookup, mockArtifactManager, routingCreateSpy } =
      fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Current is multisig (default), desired is routing
    const result = await ismWriter.applyUpdate(EXISTING_ISM_ADDRESS, {
      config: { type: 'domainRoutingIsm', owner: '0xOwner', domains: {} },
    });

    expect(result.action).to.equal('create');
    expect(result.deployed.deployed.address).to.equal(NEW_ISM_ADDRESS);
    expect('receipts' in result).to.be.true;
    expect(routingCreateSpy.calledOnce).to.be.true;
  });

  it('unchanged immutable config -> action:noop with same address', async () => {
    const { signer, chainLookup, mockArtifactManager, multisigCreateSpy } =
      fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired matches current (default mock config)
    const result = await ismWriter.applyUpdate(EXISTING_ISM_ADDRESS, {
      config: {
        type: 'messageIdMultisigIsm',
        validators: ['0xValidator1'],
        threshold: 1,
      },
    });

    expect(result.action).to.equal('noop');
    expect(result.deployed.deployed.address).to.equal(EXISTING_ISM_ADDRESS);
    expect(multisigCreateSpy.called).to.be.false;
  });

  it('changed immutable config -> action:create with new address', async () => {
    const { signer, chainLookup, mockArtifactManager, multisigCreateSpy } =
      fixture;
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired differs from current
    const result = await ismWriter.applyUpdate(EXISTING_ISM_ADDRESS, {
      config: {
        type: 'messageIdMultisigIsm',
        validators: ['0xValidator1', '0xValidator2'],
        threshold: 2,
      },
    });

    expect(result.action).to.equal('create');
    expect(result.deployed.deployed.address).to.equal(NEW_ISM_ADDRESS);
    expect('receipts' in result).to.be.true;
    expect(multisigCreateSpy.calledOnce).to.be.true;
  });

  it('changed mutable config -> action:update with same address and txs', async () => {
    const { signer, chainLookup, mockArtifactManager, routingCreateSpy } =
      fixture;

    // Configure current ISM as routing
    (mockArtifactManager.readIsm as Sinon.SinonStub).resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: { type: 'domainRoutingIsm', owner: '0xOwner', domains: {} },
      deployed: { address: EXISTING_ISM_ADDRESS },
    } satisfies DeployedRawIsmArtifact);

    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired has additional domain
    const result = await ismWriter.applyUpdate(EXISTING_ISM_ADDRESS, {
      config: {
        type: 'domainRoutingIsm',
        owner: '0xOwner',
        domains: {
          1: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: '0xDomainIsm1' },
          },
        },
      },
    });

    expect(result.action).to.equal('update');
    expect(result.deployed.deployed.address).to.equal(EXISTING_ISM_ADDRESS);
    expect('txs' in result).to.be.true;
    if (result.action === 'update') {
      expect(result.txs.length).to.be.greaterThan(0);
    }
    expect(routingCreateSpy.called).to.be.false;
  });
});
