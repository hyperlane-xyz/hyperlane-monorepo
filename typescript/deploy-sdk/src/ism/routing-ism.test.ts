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
import { ApplyUpdateResult, RoutingIsmWriter } from './routing-ism.js';

/**
 * Tests for RoutingIsmWriter.applyUpdate() operation.
 *
 * These tests verify that routing ISM updates are domain-ID driven, not artifact-state driven.
 * The implementation should:
 * 1. Read current on-chain routing ISM state
 * 2. Compare desired domains with current domains by domain ID
 * 3. For existing domains: call applyUpdate() to compare configs
 * 4. For new domains: call create()
 *
 * This fixes the bug where all domains marked as NEW get created, even if they
 * already exist on-chain with the same config.
 */
describe('RoutingIsmWriter applyUpdate', () => {
  let signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  let chainLookup: ChainLookup;
  let mockArtifactManager: IRawIsmArtifactManager;
  let mockIsmWriter: IsmWriter;

  // Spies
  let ismWriterCreateSpy: Sinon.SinonStub;
  let ismWriterApplyUpdateSpy: Sinon.SinonStub;
  let rawRoutingUpdateSpy: Sinon.SinonStub;

  // Test addresses
  const routingIsmAddress = '0xRoutingIsm';
  const domain2IsmAddress = '0xDomain2Ism';
  const newIsmAddress = '0xNewIsm';

  // Test configs
  const domain1Config: MultisigIsmConfig = {
    type: 'messageIdMultisigIsm',
    validators: ['0xValidator1'],
    threshold: 1,
  };
  const domain2Config: MultisigIsmConfig = {
    type: 'messageIdMultisigIsm',
    validators: ['0xValidator2'],
    threshold: 1,
  };
  const domain2ChangedConfig: MultisigIsmConfig = {
    type: 'messageIdMultisigIsm',
    validators: ['0xValidator2', '0xValidator3'],
    threshold: 2,
  };

  beforeEach(async () => {
    signer = await MockSigner.connectWithSigner();

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

    // Create spy for IsmWriter.create()
    ismWriterCreateSpy = Sinon.stub().callsFake(async (artifact) => {
      return [
        {
          artifactState: ArtifactState.DEPLOYED,
          config: artifact.config,
          deployed: { address: newIsmAddress },
        } satisfies DeployedIsmArtifact,
        [] as TxReceipt[],
      ];
    });

    // Create spy for IsmWriter.applyUpdate() - will be configured per test
    ismWriterApplyUpdateSpy = Sinon.stub();

    // Create mock IsmWriter
    mockIsmWriter = {
      create: ismWriterCreateSpy,
      update: Sinon.stub().resolves([]),
      applyUpdate: ismWriterApplyUpdateSpy,
      read: Sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: domain2Config,
        deployed: { address: domain2IsmAddress },
      } satisfies DeployedIsmArtifact),
    } as unknown as IsmWriter;

    // Create spy for raw routing writer
    rawRoutingUpdateSpy = Sinon.stub().resolves([
      { annotation: 'routing ism update tx' } as AnnotatedTx,
    ]);

    const mockRawRoutingWriter: ArtifactWriter<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      create: Sinon.stub().resolves([
        {
          artifactState: ArtifactState.DEPLOYED,
          config: { type: 'domainRoutingIsm', owner: '0xOwner', domains: {} },
          deployed: { address: routingIsmAddress },
        } satisfies DeployedRawIsmArtifact,
        [] as TxReceipt[],
      ]),
      update: rawRoutingUpdateSpy,
      read: Sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: '0xOwner',
          domains: {
            2: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: domain2IsmAddress },
            },
          },
        },
        deployed: { address: routingIsmAddress },
      } satisfies DeployedRawIsmArtifact),
    };

    // Create mock artifact manager - returns different ISM types based on address
    // This is critical to avoid infinite recursion in IsmReader.expandRoutingIsm()
    const readIsmStub = Sinon.stub();
    readIsmStub.callsFake(async (address: string) => {
      if (address === routingIsmAddress) {
        // Top-level routing ISM with domain 2 pointing to domain2IsmAddress
        return {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: 'domainRoutingIsm',
            owner: '0xOwner',
            domains: {
              2: {
                artifactState: ArtifactState.UNDERIVED,
                deployed: { address: domain2IsmAddress },
              },
            },
          },
          deployed: { address: routingIsmAddress },
        } satisfies DeployedRawIsmArtifact;
      } else if (address === domain2IsmAddress) {
        // Nested multisig ISM (non-routing to avoid infinite recursion)
        return {
          artifactState: ArtifactState.DEPLOYED,
          config: domain2Config,
          deployed: { address: domain2IsmAddress },
        } satisfies DeployedIsmArtifact;
      }
      throw new Error(`Unexpected readIsm call for address: ${address}`);
    });

    mockArtifactManager = {
      readIsm: readIsmStub,

      createReader: ((_type: string) => {
        return mockRawRoutingWriter as ArtifactReader<
          RawIsmArtifactConfig,
          DeployedIsmAddress
        >;
      }) as IRawIsmArtifactManager['createReader'],

      createWriter: ((type: string, _signer: unknown) => {
        if (type === AltVM.IsmType.ROUTING) {
          return mockRawRoutingWriter as ArtifactWriter<
            RawIsmArtifactConfig,
            DeployedIsmAddress
          >;
        }
        throw new Error(`Unexpected createWriter for ${type}`);
      }) as IRawIsmArtifactManager['createWriter'],
    } satisfies Partial<IRawIsmArtifactManager> as IRawIsmArtifactManager;
  });

  afterEach(() => {
    Sinon.restore();
  });

  /**
   * Scenario 1: Existing domain with unchanged config should be noop, new domain should be created.
   *
   * Current on-chain: routing ISM with domain 2 (validator2, threshold 1)
   * Desired: domains 1 (new) and 2 (same config as current)
   *
   * Expected:
   * - create() called once for domain 1
   * - applyUpdate() called once for domain 2, returns noop
   * - Domain 2 keeps its existing address
   */
  it('existing domain unchanged -> noop, new domain -> create', async () => {
    // Configure applyUpdate to return noop for domain 2 (config unchanged)
    ismWriterApplyUpdateSpy.callsFake(
      async (
        currentAddress: string,
        desired: { config: MultisigIsmConfig },
      ): Promise<ApplyUpdateResult> => {
        if (currentAddress === domain2IsmAddress) {
          return {
            action: 'noop',
            deployed: {
              artifactState: ArtifactState.DEPLOYED,
              config: desired.config,
              deployed: { address: domain2IsmAddress },
            },
          };
        }
        throw new Error(`Unexpected applyUpdate call for ${currentAddress}`);
      },
    );

    const routingIsmWriter = new RoutingIsmWriter(
      mockArtifactManager,
      chainLookup,
      signer,
      mockIsmWriter,
    );

    // Desired: domains 1 (NEW) + domain 2 (NEW but same config as on-chain)
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
            artifactState: ArtifactState.NEW,
            config: domain1Config,
          },
          2: {
            artifactState: ArtifactState.NEW, // Marked NEW but actually exists with same config
            config: domain2Config,
          },
        },
      },
      deployed: { address: routingIsmAddress },
    };

    // ACT - call applyUpdate (not update) to use domain-ID driven logic
    const result = await routingIsmWriter.applyUpdate(routingIsmAddress, {
      config: desiredArtifact.config,
    });

    // ASSERT
    // create() should be called once for domain 1 only
    expect(
      ismWriterCreateSpy.callCount,
      'create() should be called once for domain 1',
    ).to.equal(1);
    expect(ismWriterCreateSpy.getCall(0).args[0].config).to.deep.equal(
      domain1Config,
    );

    // applyUpdate() should be called once for domain 2
    expect(
      ismWriterApplyUpdateSpy.callCount,
      'applyUpdate() should be called once for domain 2',
    ).to.equal(1);
    expect(ismWriterApplyUpdateSpy.getCall(0).args[0]).to.equal(
      domain2IsmAddress,
    );

    // Result should have domain 2 with its original address (not newIsmAddress)
    expect(result.action).to.equal('update');
    if (result.action === 'update') {
      const domains = (result.deployed.config as RoutingIsmArtifactConfig)
        .domains;
      const domain2 = domains[2];
      const domain1 = domains[1];
      expect('deployed' in domain2 && domain2.deployed.address).to.equal(
        domain2IsmAddress,
      );
      expect('deployed' in domain1 && domain1.deployed.address).to.equal(
        newIsmAddress,
      );
    }
  });

  /**
   * Scenario 2: Existing domain with changed config should be recreated, new domain should be created.
   *
   * Current on-chain: routing ISM with domain 2 (validator2, threshold 1)
   * Desired: domains 1 (new) and 2 (validator2+validator3, threshold 2 - CHANGED)
   *
   * Expected:
   * - create() called once for domain 1
   * - applyUpdate() called once for domain 2, returns create with new address
   * - Domain 2 gets new address
   */
  it('existing domain changed -> create new, new domain -> create', async () => {
    const newDomain2Address = '0xNewDomain2Ism';

    // Configure applyUpdate to return create for domain 2 (config changed)
    ismWriterApplyUpdateSpy.callsFake(
      async (
        currentAddress: string,
        desired: { config: MultisigIsmConfig },
      ): Promise<ApplyUpdateResult> => {
        if (currentAddress === domain2IsmAddress) {
          return {
            action: 'create',
            deployed: {
              artifactState: ArtifactState.DEPLOYED,
              config: desired.config,
              deployed: { address: newDomain2Address },
            },
            receipts: [],
          };
        }
        throw new Error(`Unexpected applyUpdate call for ${currentAddress}`);
      },
    );

    const routingIsmWriter = new RoutingIsmWriter(
      mockArtifactManager,
      chainLookup,
      signer,
      mockIsmWriter,
    );

    // Desired: domains 1 (NEW) + domain 2 (NEW with CHANGED config)
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
            artifactState: ArtifactState.NEW,
            config: domain1Config,
          },
          2: {
            artifactState: ArtifactState.NEW,
            config: domain2ChangedConfig, // Different from current on-chain
          },
        },
      },
      deployed: { address: routingIsmAddress },
    };

    // ACT
    const result = await routingIsmWriter.applyUpdate(routingIsmAddress, {
      config: desiredArtifact.config,
    });

    // ASSERT
    // create() should be called once for domain 1 only
    expect(
      ismWriterCreateSpy.callCount,
      'create() should be called once for domain 1',
    ).to.equal(1);
    expect(ismWriterCreateSpy.getCall(0).args[0].config).to.deep.equal(
      domain1Config,
    );

    // applyUpdate() should be called once for domain 2
    expect(
      ismWriterApplyUpdateSpy.callCount,
      'applyUpdate() should be called once for domain 2',
    ).to.equal(1);
    expect(ismWriterApplyUpdateSpy.getCall(0).args[0]).to.equal(
      domain2IsmAddress,
    );
    expect(ismWriterApplyUpdateSpy.getCall(0).args[1].config).to.deep.equal(
      domain2ChangedConfig,
    );

    // Result should have domain 2 with NEW address (config changed, so recreated)
    expect(result.action).to.equal('update');
    if (result.action === 'update') {
      const domains = (result.deployed.config as RoutingIsmArtifactConfig)
        .domains;
      const domain2 = domains[2];
      const domain1 = domains[1];
      expect('deployed' in domain2 && domain2.deployed.address).to.equal(
        newDomain2Address,
      );
      expect('deployed' in domain1 && domain1.deployed.address).to.equal(
        newIsmAddress,
      );
    }
  });
});
