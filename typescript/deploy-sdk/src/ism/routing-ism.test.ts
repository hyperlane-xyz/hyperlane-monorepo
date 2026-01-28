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
  DeployedIsmArtifact,
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  MultisigIsmConfig,
  RawIsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { IsmWriter } from './generic-ism-writer.js';
import { RoutingIsmWriter } from './routing-ism.js';

/**
 * TDD tests for RoutingIsmWriter.update() operation.
 *
 * These tests verify routing ISM update behavior for nested domain ISMs:
 * - New domain (NEW artifact): should call IsmWriter.create() for the nested ISM
 * - Existing domain (DEPLOYED artifact): should call IsmWriter.update() for the nested ISM
 *
 * The key insight is that RoutingIsmWriter should use IsmWriter for nested operations,
 * not raw protocol-specific writers, to get proper type-change and config-change detection.
 *
 * Tests are written TDD-style and will fail until the implementation is updated.
 */
describe('RoutingIsmWriter update', () => {
  let signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  let chainLookup: ChainLookup;
  let mockArtifactManager: IRawIsmArtifactManager;
  let mockIsmWriter: IsmWriter;

  // Spies for tracking IsmWriter method calls
  let ismWriterCreateSpy: Sinon.SinonStub;
  let ismWriterUpdateSpy: Sinon.SinonStub;

  // Spies for raw routing writer (for the routing ISM itself, not nested)
  let rawRoutingCreateSpy: Sinon.SinonStub;
  let rawRoutingUpdateSpy: Sinon.SinonStub;

  // Test addresses
  const routingIsmAddress = '0xRoutingIsm';
  const domain1IsmAddress = '0xDomain1Ism';
  const newIsmAddress = '0xNewIsm';

  beforeEach(async () => {
    signer = await MockSigner.connectWithSigner();

    // Mock chain lookup
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

    // Create spies for IsmWriter
    ismWriterCreateSpy = Sinon.stub().resolves([
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'messageIdMultisigIsm',
          validators: ['0xValidator1'],
          threshold: 1,
        },
        deployed: { address: newIsmAddress },
      } satisfies DeployedIsmArtifact,
      [] as TxReceipt[],
    ]);

    ismWriterUpdateSpy = Sinon.stub().resolves([
      { annotation: 'nested ism update tx' } as AnnotatedTx,
    ]);

    // Create mock IsmWriter
    mockIsmWriter = {
      create: ismWriterCreateSpy,
      update: ismWriterUpdateSpy,
      read: Sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'messageIdMultisigIsm',
          validators: ['0xValidator1'],
          threshold: 1,
        },
        deployed: { address: domain1IsmAddress },
      } satisfies DeployedIsmArtifact),
    } as unknown as IsmWriter;

    // Create spies for raw routing writer
    rawRoutingCreateSpy = Sinon.stub().resolves([
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: '0xOwner',
          domains: {},
        },
        deployed: { address: routingIsmAddress },
      } satisfies DeployedRawIsmArtifact,
      [] as TxReceipt[],
    ]);

    rawRoutingUpdateSpy = Sinon.stub().resolves([
      { annotation: 'routing ism update tx' } as AnnotatedTx,
    ]);

    const mockRawRoutingWriter: ArtifactWriter<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      create: rawRoutingCreateSpy,
      update: rawRoutingUpdateSpy,
      read: Sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: '0xOwner',
          domains: {},
        },
        deployed: { address: routingIsmAddress },
      } satisfies DeployedRawIsmArtifact),
    };

    // Create mock artifact manager
    mockArtifactManager = {
      readIsm: Sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: '0xOwner',
          domains: {
            1: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: domain1IsmAddress },
            },
          },
        },
        deployed: { address: routingIsmAddress },
      } satisfies DeployedRawIsmArtifact),

      createReader: ((_type: string) => {
        return mockRawRoutingWriter as ArtifactReader<
          RawIsmArtifactConfig,
          DeployedIsmAddress
        >;
      }) as IRawIsmArtifactManager['createReader'],

      createWriter: ((type: string, _signer: unknown) => {
        // Only return raw routing writer for ROUTING type
        // Other types should go through IsmWriter (which is mocked separately)
        if (type === AltVM.IsmType.ROUTING) {
          return mockRawRoutingWriter as ArtifactWriter<
            RawIsmArtifactConfig,
            DeployedIsmAddress
          >;
        }
        throw new Error(
          `Unexpected createWriter call for type ${type} - nested ISMs should use IsmWriter`,
        );
      }) as IRawIsmArtifactManager['createWriter'],
    } satisfies Partial<IRawIsmArtifactManager> as IRawIsmArtifactManager;
  });

  afterEach(() => {
    Sinon.restore();
  });

  /**
   * Test: Update routing ISM with a new domain should call create for nested artifact.
   *
   * When a routing ISM update includes a new domain (with NEW artifact state),
   * IsmWriter.create() should be called to deploy the nested ISM.
   *
   * Current behavior: uses artifactManager.createWriter().create() directly
   * Expected behavior: uses IsmWriter.create() for proper type handling
   */
  it('update with new domain -> call create for nested artifact', async () => {
    // ARRANGE
    const routingIsmWriter = new RoutingIsmWriter(
      mockArtifactManager,
      chainLookup,
      signer,
      mockIsmWriter,
    );

    // Current: routing ISM with domain 1 only
    // Desired: routing ISM with domain 1 + new domain 2
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
            deployed: { address: domain1IsmAddress },
          },
          2: {
            // NEW domain - should trigger create
            artifactState: ArtifactState.NEW,
            config: {
              type: 'messageIdMultisigIsm',
              validators: ['0xValidator2'],
              threshold: 1,
            },
          },
        },
      },
      deployed: { address: routingIsmAddress },
    };

    // ACT
    await routingIsmWriter.update(desiredArtifact);

    // ASSERT
    // IsmWriter.create() should be called for the new domain 2 ISM
    expect(
      ismWriterCreateSpy.calledOnce,
      'Expected IsmWriter.create() for new domain',
    ).to.be.true;

    // Verify it was called with the correct config
    const createCall = ismWriterCreateSpy.getCall(0);
    expect(createCall.args[0].config.type).to.equal('messageIdMultisigIsm');
    expect(createCall.args[0].config.validators).to.deep.equal([
      '0xValidator2',
    ]);

    // IsmWriter.update() should NOT be called (domain 1 is UNDERIVED, domain 2 is NEW)
    expect(ismWriterUpdateSpy.called).to.be.false;

    // Raw routing writer update should still be called to enroll the new domain
    expect(rawRoutingUpdateSpy.calledOnce).to.be.true;
  });

  /**
   * Test: Update routing ISM with existing domain change should call update on nested artifact.
   *
   * When a routing ISM update includes an existing domain with DEPLOYED state
   * (indicating config was read and potentially changed), IsmWriter.update()
   * should be called to handle the nested ISM update.
   *
   * Current behavior: uses artifactManager.createWriter().update() directly (raw writer)
   * Expected behavior: uses IsmWriter.update() for proper type/config change detection
   */
  it('update with existing domain change -> call update on nested artifact', async () => {
    // ARRANGE
    const routingIsmWriter = new RoutingIsmWriter(
      mockArtifactManager,
      chainLookup,
      signer,
      mockIsmWriter,
    );

    // Desired: routing ISM with domain 1 having DEPLOYED state (config read/changed)
    const domain1Config: MultisigIsmConfig = {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator1', '0xValidator2'], // Changed validators
      threshold: 2, // Changed threshold
    };

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
            // DEPLOYED state - should trigger update
            artifactState: ArtifactState.DEPLOYED,
            config: domain1Config,
            deployed: { address: domain1IsmAddress },
          },
        },
      },
      deployed: { address: routingIsmAddress },
    };

    // ACT
    await routingIsmWriter.update(desiredArtifact);

    // ASSERT
    // IsmWriter.update() should be called for the existing domain 1 ISM
    expect(
      ismWriterUpdateSpy.calledOnce,
      'Expected IsmWriter.update() for existing domain',
    ).to.be.true;

    // Verify it was called with the correct artifact
    const updateCall = ismWriterUpdateSpy.getCall(0);
    expect(updateCall.args[0].config.type).to.equal('messageIdMultisigIsm');
    expect(updateCall.args[0].deployed.address).to.equal(domain1IsmAddress);

    // IsmWriter.create() should NOT be called
    expect(ismWriterCreateSpy.called).to.be.false;

    // Raw routing writer update should still be called
    expect(rawRoutingUpdateSpy.calledOnce).to.be.true;
  });
});
