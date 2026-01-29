import { expect } from 'chai';
import Sinon from 'sinon';

import {
  ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  IsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { IsmWriter } from './generic-ism-writer.js';
import { ApplyUpdateResult, RoutingIsmWriter } from './routing-ism.js';
import {
  RoutingIsmWriterTestFixture,
  TEST_ADDRESSES,
  TEST_CONFIGS,
  createRoutingIsmWriterTestFixture,
} from './test-fixtures.js';

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
  let fixture: RoutingIsmWriterTestFixture;

  beforeEach(async () => {
    fixture = await createRoutingIsmWriterTestFixture();
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
    const {
      signer,
      chainLookup,
      mockArtifactManager,
      mockIsmWriter,
      ismWriterCreateSpy,
      ismWriterApplyUpdateSpy,
    } = fixture;

    // Configure applyUpdate to return noop for domain 2 (config unchanged)
    ismWriterApplyUpdateSpy.callsFake(
      async (
        currentAddress: string,
        desired: { config: IsmArtifactConfig },
      ): Promise<ApplyUpdateResult> => {
        if (currentAddress === TEST_ADDRESSES.DOMAIN2_ISM) {
          return {
            action: 'noop',
            deployed: {
              artifactState: ArtifactState.DEPLOYED,
              config: desired.config,
              deployed: { address: TEST_ADDRESSES.DOMAIN2_ISM },
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
      mockIsmWriter as unknown as IsmWriter,
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
            config: TEST_CONFIGS.multisig.domain1,
          },
          2: {
            artifactState: ArtifactState.NEW,
            config: TEST_CONFIGS.multisig.domain2,
          },
        },
      },
      deployed: { address: TEST_ADDRESSES.ROUTING_ISM },
    };

    const result = await routingIsmWriter.applyUpdate(
      TEST_ADDRESSES.ROUTING_ISM,
      {
        config: desiredArtifact.config,
      },
    );

    // create() should be called once for domain 1 only
    expect(
      ismWriterCreateSpy.callCount,
      'create() should be called once for domain 1',
    ).to.equal(1);
    expect(ismWriterCreateSpy.getCall(0).args[0].config).to.deep.equal(
      TEST_CONFIGS.multisig.domain1,
    );

    // applyUpdate() should be called once for domain 2
    expect(
      ismWriterApplyUpdateSpy.callCount,
      'applyUpdate() should be called once for domain 2',
    ).to.equal(1);
    expect(ismWriterApplyUpdateSpy.getCall(0).args[0]).to.equal(
      TEST_ADDRESSES.DOMAIN2_ISM,
    );

    // Result should have domain 2 with its original address (not newIsmAddress)
    expect(result.action).to.equal('update');
    if (result.action === 'update') {
      const domains = (result.deployed.config as RoutingIsmArtifactConfig)
        .domains;
      expect('deployed' in domains[2] && domains[2].deployed.address).to.equal(
        TEST_ADDRESSES.DOMAIN2_ISM,
      );
      expect('deployed' in domains[1] && domains[1].deployed.address).to.equal(
        TEST_ADDRESSES.NEW_ISM,
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
    const {
      signer,
      chainLookup,
      mockArtifactManager,
      mockIsmWriter,
      ismWriterCreateSpy,
      ismWriterApplyUpdateSpy,
    } = fixture;

    const newDomain2Address = '0xNewDomain2Ism';

    // Configure applyUpdate to return create for domain 2 (config changed)
    ismWriterApplyUpdateSpy.callsFake(
      async (
        currentAddress: string,
        desired: { config: IsmArtifactConfig },
      ): Promise<ApplyUpdateResult> => {
        if (currentAddress === TEST_ADDRESSES.DOMAIN2_ISM) {
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
      mockIsmWriter as unknown as IsmWriter,
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
            config: TEST_CONFIGS.multisig.domain1,
          },
          2: {
            artifactState: ArtifactState.NEW,
            config: TEST_CONFIGS.multisig.domain2Changed,
          },
        },
      },
      deployed: { address: TEST_ADDRESSES.ROUTING_ISM },
    };

    const result = await routingIsmWriter.applyUpdate(
      TEST_ADDRESSES.ROUTING_ISM,
      {
        config: desiredArtifact.config,
      },
    );

    // create() should be called once for domain 1 only
    expect(
      ismWriterCreateSpy.callCount,
      'create() should be called once for domain 1',
    ).to.equal(1);
    expect(ismWriterCreateSpy.getCall(0).args[0].config).to.deep.equal(
      TEST_CONFIGS.multisig.domain1,
    );

    // applyUpdate() should be called once for domain 2
    expect(
      ismWriterApplyUpdateSpy.callCount,
      'applyUpdate() should be called once for domain 2',
    ).to.equal(1);
    expect(ismWriterApplyUpdateSpy.getCall(0).args[0]).to.equal(
      TEST_ADDRESSES.DOMAIN2_ISM,
    );
    expect(ismWriterApplyUpdateSpy.getCall(0).args[1].config).to.deep.equal(
      TEST_CONFIGS.multisig.domain2Changed,
    );

    // Result should have domain 2 with NEW address (config changed, so recreated)
    expect(result.action).to.equal('update');
    if (result.action === 'update') {
      const domains = (result.deployed.config as RoutingIsmArtifactConfig)
        .domains;
      expect('deployed' in domains[2] && domains[2].deployed.address).to.equal(
        newDomain2Address,
      );
      expect('deployed' in domains[1] && domains[1].deployed.address).to.equal(
        TEST_ADDRESSES.NEW_ISM,
      );
    }
  });
});
