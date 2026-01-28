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

/**
 * TDD tests for IsmWriter.update() operation.
 *
 * These tests verify the update behavior for different ISM types:
 * - Immutable ISMs (multisig types in STATIC_ISM_TYPES): require new deployment when config changes
 * - Mutable ISMs (routing): support in-place updates
 *
 * Current behavior (to be changed):
 * - update() only handles routing ISMs, returns [] for others
 * - Decision logic (shouldDeployNewIsm) lives in AltVMCoreModule/AltVMWarpModule
 *
 * Expected behavior (TDD target):
 * - update() should detect type changes and config changes
 * - For immutable types with config change: trigger create() internally
 * - For mutable types: delegate to type-specific update()
 *
 * Tests are written TDD-style and will fail until the implementation is updated.
 */
describe('IsmWriter update', () => {
  let signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  let chainLookup: ChainLookup;
  let mockArtifactManager: IRawIsmArtifactManager;

  // Mock writers with spies
  let mockMultisigWriter: ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>;
  let mockRoutingWriter: ArtifactWriter<
    RawRoutingIsmArtifactConfig,
    DeployedIsmAddress
  >;

  // Spies for tracking method calls
  let multisigCreateSpy: Sinon.SinonStub;
  let multisigUpdateSpy: Sinon.SinonStub;
  let routingCreateSpy: Sinon.SinonStub;
  let routingUpdateSpy: Sinon.SinonStub;

  // Test addresses
  const existingIsmAddress = '0xExistingIsm';
  const newIsmAddress = '0xNewIsm';

  beforeEach(async () => {
    signer = await MockSigner.connectWithSigner();

    // Mock chain lookup - minimal implementation
    chainLookup = {
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
    } satisfies ChainLookup;

    // Create mock multisig writer (immutable ISM type)
    multisigCreateSpy = Sinon.stub().resolves([
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'messageIdMultisigIsm',
          validators: ['0xValidator1'],
          threshold: 1,
        },
        deployed: { address: newIsmAddress },
      } satisfies DeployedRawIsmArtifact,
      [] as TxReceipt[],
    ]);
    multisigUpdateSpy = Sinon.stub().resolves([] as AnnotatedTx[]);

    mockMultisigWriter = {
      create: multisigCreateSpy,
      update: multisigUpdateSpy,
      read: Sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'messageIdMultisigIsm',
          validators: ['0xValidator1'],
          threshold: 1,
        },
        deployed: { address: existingIsmAddress },
      } satisfies DeployedRawIsmArtifact),
    };

    // Create mock routing writer (mutable ISM type)
    routingCreateSpy = Sinon.stub().resolves([
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: '0xOwner',
          domains: {},
        },
        deployed: { address: newIsmAddress },
      } satisfies DeployedRawIsmArtifact,
      [] as TxReceipt[],
    ]);
    routingUpdateSpy = Sinon.stub().resolves([
      { annotation: 'mock routing update tx' } as AnnotatedTx,
    ]);

    mockRoutingWriter = {
      create: routingCreateSpy,
      update: routingUpdateSpy,
      read: Sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: '0xOwner',
          domains: {},
        },
        deployed: { address: existingIsmAddress },
      } satisfies DeployedRawIsmArtifact),
    };

    // Create mock artifact manager that returns appropriate writer based on type
    mockArtifactManager = {
      readIsm: Sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'messageIdMultisigIsm',
          validators: ['0xValidator1'],
          threshold: 1,
        },
        deployed: { address: existingIsmAddress },
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
  });

  afterEach(() => {
    Sinon.restore();
  });

  /**
   * Test: Update to a different ISM type should create a new ISM.
   *
   * When the desired ISM type differs from the current one,
   * a new ISM must be deployed regardless of mutability.
   *
   * Current behavior: update() ignores type mismatch, just returns [] for non-routing.
   * Expected behavior: update() should detect type change and call create() for new type.
   */
  it('update to different ISM type -> create new ISM', async () => {
    // ARRANGE
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Desired artifact represents what we want: a routing ISM at the existing address
    // but the current on-chain ISM is a multisig (different type)
    // In real usage, this artifact would be constructed by comparing current vs desired
    const desiredArtifact: ArtifactDeployed<
      RoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'domainRoutingIsm',
        owner: '0xOwner',
        domains: {},
      },
      deployed: { address: existingIsmAddress },
    };

    // ACT
    // Call update() with the desired routing config
    // Current impl: delegates to routingWriter.update() because config.type is ROUTING
    // Expected impl: should detect that current ISM (multisig) != desired (routing)
    //                and call create() instead of update()
    await ismWriter.update(desiredArtifact);

    // ASSERT
    // Expected: routing writer's create() should be called (type change = new deployment)
    // Current: routing writer's update() is called (incorrect for type change)
    expect(routingCreateSpy.calledOnce, 'Expected create() for type change').to
      .be.true;
    expect(
      routingUpdateSpy.called,
      'Should not call update() when type changes',
    ).to.be.false;
  });

  /**
   * Test: Update same immutable type with unchanged config should be a no-op.
   *
   * When the desired config exactly matches the current deployed config
   * for an immutable ISM type, no action should be taken.
   *
   * Current behavior: returns [] (correct, but accidentally - it returns [] for all non-routing)
   * Expected behavior: explicitly detect unchanged config and skip
   */
  it('update same immutable type, unchanged config -> no-op', async () => {
    // ARRANGE
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    const config: MultisigIsmConfig = {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator1'],
      threshold: 1,
    };

    // Current and desired have the same config
    const artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress> = {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: existingIsmAddress },
    };

    // ACT
    const txs = await ismWriter.update(artifact);

    // ASSERT
    // For immutable types with unchanged config, should be no-op
    expect(txs).to.have.lengthOf(0);
    expect(multisigCreateSpy.called).to.be.false;
    expect(multisigUpdateSpy.called).to.be.false;
  });

  /**
   * Test: Update same immutable type with changed config should create new ISM.
   *
   * Immutable ISMs (like multisig) cannot be updated in-place.
   * When config changes, a new ISM must be deployed.
   *
   * Current behavior: returns [] (incorrect - config change should trigger create)
   * Expected behavior: detect config change for immutable type and call create()
   */
  it('update same immutable type, changed config -> create new ISM', async () => {
    // ARRANGE
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Current on-chain config (returned by readIsm)
    const currentConfig: MultisigIsmConfig = {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator1'],
      threshold: 1,
    };

    // Configure mock to return current config when reading
    (mockArtifactManager.readIsm as Sinon.SinonStub).resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: currentConfig,
      deployed: { address: existingIsmAddress },
    } satisfies DeployedRawIsmArtifact);

    // Desired config: same type but different validators/threshold
    const desiredConfig: MultisigIsmConfig = {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator1', '0xValidator2'],
      threshold: 2,
    };

    const desiredArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: desiredConfig,
      deployed: { address: existingIsmAddress },
    };

    // ACT
    await ismWriter.update(desiredArtifact);

    // ASSERT
    // Expected: since config changed for immutable type, should create new ISM
    // Current: returns [] without calling anything (FAILS)
    expect(
      multisigCreateSpy.calledOnce,
      'Expected create() for immutable config change',
    ).to.be.true;
    expect(multisigUpdateSpy.called).to.be.false;
  });

  /**
   * Test: Update same mutable type with changed config should update existing ISM.
   *
   * Mutable ISMs (like routing) support in-place updates.
   * When config changes, update() should be called, not create().
   *
   * Current behavior: delegates to routingWriter.update() (correct)
   * Expected behavior: same - should call update() for mutable types
   */
  it('update same mutable type, changed config -> update existing ISM', async () => {
    // ARRANGE
    const ismWriter = new IsmWriter(mockArtifactManager, chainLookup, signer);

    // Current on-chain: routing ISM with domain 1
    const currentConfig: RawRoutingIsmArtifactConfig = {
      type: 'domainRoutingIsm',
      owner: '0xOwner',
      domains: {
        1: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0xDomainIsm1' },
        },
      },
    };

    (mockArtifactManager.readIsm as Sinon.SinonStub).resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: currentConfig,
      deployed: { address: existingIsmAddress },
    } satisfies DeployedRawIsmArtifact);

    // Desired: same type but with additional domain
    const desiredConfig: RoutingIsmArtifactConfig = {
      type: 'domainRoutingIsm',
      owner: '0xOwner',
      domains: {
        1: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '0xDomainIsm1' },
        },
        2: {
          artifactState: ArtifactState.NEW,
          config: {
            type: 'messageIdMultisigIsm',
            validators: ['0xValidator1'],
            threshold: 1,
          },
        },
      },
    };

    const desiredArtifact: ArtifactDeployed<
      RoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: desiredConfig,
      deployed: { address: existingIsmAddress },
    };

    // ACT
    const txs = await ismWriter.update(desiredArtifact);

    // ASSERT
    // For mutable type with changed config, should call update() not create()
    expect(routingUpdateSpy.calledOnce, 'Expected update() for mutable type').to
      .be.true;
    expect(routingCreateSpy.called, 'Should not call create() for mutable type')
      .to.be.false;
    // Should return update transactions
    expect(txs.length).to.be.greaterThan(0);
  });
});
