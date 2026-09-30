import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import {
  ArtifactNew,
  ArtifactState,
  isArtifactDeployed,
  isArtifactNew,
  isArtifactUnderived,
} from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  DeployedIsmArtifact,
  IsmArtifactConfig,
  IsmType,
  MultisigIsmConfig,
  RoutingIsmArtifactConfig,
  UnsupportedIsmArtifactTypeError,
  isDirectIsmArtifactConfig,
  isMutableIsmConfig,
  isStaticIsmType,
  ismArtifactToDerivedConfig,
  mergeIsmArtifacts,
  throwUnsupportedIsmType,
} from './ism.js';
import { ProtocolType } from './protocolType.js';

describe('ISM type categories', () => {
  it('distinguishes mutable ISM types', () => {
    expect(
      isMutableIsmConfig({
        type: IsmType.ROUTING,
        owner: '0xowner',
        domains: {},
      }),
    ).to.equal(true);
    expect(isMutableIsmConfig({ type: IsmType.TEST_ISM })).to.equal(false);
  });

  it('distinguishes static ISM types', () => {
    expect(isStaticIsmType(IsmType.MERKLE_ROOT_MULTISIG)).to.equal(true);
    expect(isStaticIsmType(IsmType.ROUTING)).to.equal(false);
  });
});

describe('unsupported ISM artifact types', () => {
  it('includes the ISM type and protocol', () => {
    const ismType = IsmType.PAUSABLE;

    expect(() => throwUnsupportedIsmType(ismType, ProtocolType.Aleo))
      .to.throw(UnsupportedIsmArtifactTypeError)
      .and.include({
        ismType,
        protocol: ProtocolType.Aleo,
      });
  });

  it('rejects deriving an unsupported valid ISM type', () => {
    const chainLookup: ChainLookup = {
      getChainMetadata: () => {
        throw new Error('not needed');
      },
      getDomainId: () => null,
      getChainName: () => null,
      getKnownChainNames: () => [],
    };
    const artifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: IsmType.UNKNOWN },
      deployed: { address: '0xUnknownIsm' },
    };

    expect(() => ismArtifactToDerivedConfig(artifact, chainLookup)).to.throw(
      `Unhandled ISM type in ismArtifactToDerivedConfig: ${IsmType.UNKNOWN}`,
    );
  });
});

describe('isDirectIsmArtifactConfig', () => {
  it('distinguishes direct ISMs from nested ISM artifacts', () => {
    const nestedIsms: IsmArtifactConfig[] = [
      { type: IsmType.ROUTING, owner: '0xowner', domains: {} },
      { type: IsmType.INCREMENTAL_ROUTING, owner: '0xowner', domains: {} },
      { type: IsmType.FALLBACK_ROUTING, owner: '0xowner', domains: {} },
      {
        type: IsmType.AMOUNT_ROUTING,
        threshold: 1,
        lowerIsm: {
          artifactState: ArtifactState.NEW,
          config: { type: IsmType.TEST_ISM },
        },
        upperIsm: {
          artifactState: ArtifactState.NEW,
          config: { type: IsmType.TEST_ISM },
        },
      },
      {
        type: IsmType.AGGREGATION,
        threshold: 1,
        modules: [
          {
            artifactState: ArtifactState.NEW,
            config: { type: IsmType.TEST_ISM },
          },
        ],
      },
      {
        type: IsmType.STORAGE_AGGREGATION,
        threshold: 1,
        modules: [
          {
            artifactState: ArtifactState.NEW,
            config: { type: IsmType.TEST_ISM },
          },
        ],
      },
    ];

    expect(isDirectIsmArtifactConfig({ type: IsmType.TEST_ISM })).to.equal(
      true,
    );
    expect(nestedIsms.every((ism) => !isDirectIsmArtifactConfig(ism))).to.equal(
      true,
    );
  });
});

describe('mergeIsmArtifacts', () => {
  const address1 = '0x1111111111111111111111111111111111111111';
  const address2 = '0x2222222222222222222222222222222222222222';
  const validator1 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const validator2 = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const validator3 = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const domain1 = 1;
  const domain2 = 2;

  function getDomainIsm(config: RoutingIsmArtifactConfig, domain: number) {
    const domainIsm = config.domains[domain];
    assert(domainIsm, `Expected domain ${domain} ISM`);
    return domainIsm;
  }

  interface TestCase {
    name: string;
    currentArtifact: DeployedIsmArtifact | undefined;
    expectedArtifact:
      | { artifactState: typeof ArtifactState.NEW; config: IsmArtifactConfig }
      | DeployedIsmArtifact
      | ArtifactNew<IsmArtifactConfig>; // Input to mergeIsmArtifacts
    expectedConfig: IsmArtifactConfig; // Expected config of RESULT
    expectedArtifactState: ArtifactState; // Expected state of RESULT
    expectedAddress?: string; // Expected address of RESULT
    additionalAssertions?: (result: any) => void;
  }

  const testCases: TestCase[] = [
    // No current ISM
    {
      name: 'should return expected as NEW when no current ISM exists',
      currentArtifact: undefined,
      expectedArtifact: {
        artifactState: ArtifactState.NEW,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      },
      expectedArtifactState: ArtifactState.NEW,
    },
    {
      name: 'should treat undefined artifactState as NEW when no current ISM exists',
      currentArtifact: undefined,
      expectedArtifact: {
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      },
      expectedArtifactState: ArtifactState.NEW,
    },
    {
      name: 'should use provided address when no current ISM exists (DEPLOYED input)',
      currentArtifact: undefined,
      expectedArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      },
      expectedArtifactState: ArtifactState.DEPLOYED,
      expectedAddress: address1,
    },

    // Type changed
    {
      name: 'should return NEW when ISM type changes',
      currentArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedArtifact: {
        artifactState: ArtifactState.NEW,
        config: {
          type: 'testIsm',
        },
      },
      expectedConfig: {
        type: 'testIsm',
      },
      expectedArtifactState: ArtifactState.NEW,
    },
    {
      name: 'should return NEW when ISM type changes (DEPLOYED input)',
      currentArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'testIsm',
        },
        deployed: { address: address2 },
      },
      expectedConfig: {
        type: 'testIsm',
      },
      expectedArtifactState: ArtifactState.NEW,
    },

    // Config unchanged
    {
      name: 'should return DEPLOYED with existing address when static ISM config unchanged',
      currentArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedArtifact: {
        artifactState: ArtifactState.NEW,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      },
      expectedArtifactState: ArtifactState.DEPLOYED,
      expectedAddress: address1,
    },
    {
      name: 'should treat undefined artifactState as NEW when config unchanged',
      currentArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedArtifact: {
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      },
      expectedArtifactState: ArtifactState.DEPLOYED,
      expectedAddress: address1,
    },
    {
      name: 'should switch to explicitly provided address when config is unchanged but addresses are not (ISM redeployment)',
      currentArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address2 },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      },
      expectedArtifactState: ArtifactState.DEPLOYED,
      expectedAddress: address2,
    },

    // Static ISM - validator order normalized
    {
      name: 'should handle validator order differences (normalized comparison)',
      currentArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedArtifact: {
        artifactState: ArtifactState.NEW,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator2, validator1], // Different order
          threshold: 2,
        },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator2, validator1], // Different order
        threshold: 2,
      },
      expectedArtifactState: ArtifactState.DEPLOYED,
      expectedAddress: address1,
    },

    // Static ISM - validators changed
    {
      name: 'should return NEW when validator set changes',
      currentArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedArtifact: {
        artifactState: ArtifactState.NEW,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator3], // Different validator
          threshold: 2,
        },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator3], // Different validator
        threshold: 2,
      },
      expectedArtifactState: ArtifactState.NEW,
    },

    // Static ISM - threshold changed
    {
      name: 'should return NEW when threshold changes',
      currentArtifact: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 2,
        },
        deployed: { address: address1 },
      },
      expectedArtifact: {
        artifactState: ArtifactState.NEW,
        config: {
          type: 'merkleRootMultisigIsm',
          validators: [validator1, validator2],
          threshold: 1, // Different threshold
        },
      },
      expectedConfig: {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 1, // Different threshold
      },
      expectedArtifactState: ArtifactState.NEW,
    },
  ];

  testCases.forEach((tc) => {
    it(tc.name, () => {
      const result = mergeIsmArtifacts(tc.currentArtifact, tc.expectedArtifact);

      // Assert based on expected artifact state
      if (tc.expectedArtifactState === ArtifactState.NEW) {
        // Use helper to check - accepts both undefined and ArtifactState.NEW
        expect(isArtifactNew(result)).to.be.true;
        expect(result.config).to.deep.equal(tc.expectedConfig);
      } else if (tc.expectedArtifactState === ArtifactState.DEPLOYED) {
        expect(isArtifactDeployed(result)).to.be.true;
        assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');
        expect(result.config).to.deep.equal(tc.expectedConfig);
        expect(result.deployed.address).to.equal(tc.expectedAddress);
      }

      if (tc.additionalAssertions) {
        tc.additionalAssertions(result);
      }
    });
  });

  it('keeps a rate-limited ISM deployed when only capacity changes', () => {
    const currentArtifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.RATE_LIMITED,
        maxCapacity: '4',
        duration: 2n,
      },
      deployed: { address: address1 },
    };
    const expectedConfig: IsmArtifactConfig = {
      type: IsmType.RATE_LIMITED,
      maxCapacity: '6',
      duration: 2n,
    };

    const result = mergeIsmArtifacts(currentArtifact, {
      artifactState: ArtifactState.NEW,
      config: expectedConfig,
    });

    assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');
    expect(result.config).to.deep.equal(expectedConfig);
    expect(result.deployed.address).to.equal(address1);
  });

  it('redeploys a rate-limited ISM when duration changes', () => {
    const result = mergeIsmArtifacts(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.RATE_LIMITED,
          maxCapacity: '6',
          duration: 2n,
        },
        deployed: { address: address1 },
      },
      {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.RATE_LIMITED,
          maxCapacity: '6',
          duration: 3n,
        },
      },
    );

    expect(isArtifactNew(result)).to.equal(true);
  });

  it('redeploys a rate-limited ISM when its explicit recipient changes', () => {
    const result = mergeIsmArtifacts(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.RATE_LIMITED,
          maxCapacity: '6',
          duration: 2n,
          recipient: address1,
        },
        deployed: { address: address1 },
      },
      {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.RATE_LIMITED,
          maxCapacity: '6',
          duration: 2n,
          recipient: address2,
        },
      },
    );

    expect(isArtifactNew(result)).to.equal(true);
  });

  it('keeps a hybrid ISM deployed when only mutable fields change', () => {
    const result = mergeIsmArtifacts(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.DELAYED_FLOW_ROUTER,
          owner: address1,
          warpRouter: address1,
          thresholdBps: 100,
          maxDelay: 10,
          duration: 20n,
          remoteIsms: { '1': address1 },
        },
        deployed: { address: address1 },
      },
      {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.DELAYED_FLOW_ROUTER,
          owner: address2,
          thresholdBps: 100,
          maxDelay: 10,
          duration: 20n,
          remoteIsms: { '1': address2 },
        },
      },
    );

    expect(isArtifactDeployed(result)).to.equal(true);
  });

  it('redeploys a hybrid ISM when an immutable field changes', () => {
    const result = mergeIsmArtifacts(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.NET_FLOW_RATE_LIMITED,
          owner: address1,
          warpRouter: address1,
          thresholdBps: 100,
          duration: 20n,
        },
        deployed: { address: address1 },
      },
      {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.NET_FLOW_RATE_LIMITED,
          owner: address1,
          warpRouter: address1,
          thresholdBps: 200,
          duration: 20n,
        },
      },
    );

    expect(isArtifactNew(result)).to.equal(true);
  });

  it('redeploys a blacklist ISM when an entry is removed', () => {
    const result = mergeIsmArtifacts(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.BLACKLIST,
          owner: address1,
          blacklistedIds: ['0x01', '0x02'],
        },
        deployed: { address: address1 },
      },
      {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.BLACKLIST,
          owner: address1,
          blacklistedIds: ['0x02'],
        },
      },
    );

    expect(isArtifactNew(result)).to.equal(true);
  });

  it('keeps a blacklist ISM deployed when an entry is added', () => {
    const result = mergeIsmArtifacts(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: IsmType.BLACKLIST,
          owner: address1,
          blacklistedIds: ['0x01'],
        },
        deployed: { address: address1 },
      },
      {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.BLACKLIST,
          owner: address1,
          blacklistedIds: ['0x01', '0x02'],
        },
      },
    );

    expect(isArtifactDeployed(result)).to.equal(true);
  });

  it('redeploys a changed immutable direct ISM', () => {
    const result = mergeIsmArtifacts(
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: IsmType.TRUSTED_RELAYER, relayer: address1 },
        deployed: { address: address1 },
      },
      {
        artifactState: ArtifactState.NEW,
        config: { type: IsmType.TRUSTED_RELAYER, relayer: address2 },
      },
    );

    expect(isArtifactNew(result)).to.equal(true);
  });

  it('rejects storage aggregation artifacts as read-only', () => {
    expect(() => {
      mergeIsmArtifacts(undefined, {
        artifactState: ArtifactState.NEW,
        config: {
          type: IsmType.STORAGE_AGGREGATION,
          threshold: 1,
          modules: [
            {
              artifactState: ArtifactState.NEW,
              config: { type: IsmType.TEST_ISM },
            },
          ],
        },
      });
    }).to.throw('Aggregation ISM artifact composition is not yet supported');
  });

  // Routing ISM tests (more complex, kept separate)
  describe('Routing ISM', () => {
    for (const routingType of [
      IsmType.INCREMENTAL_ROUTING,
      IsmType.FALLBACK_ROUTING,
    ]) {
      it(`preserves the ${routingType} discriminator`, () => {
        const currentArtifact: DeployedIsmArtifact = {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: routingType,
            owner: address1,
            domains: {},
          },
          deployed: { address: address1 },
        };

        const result = mergeIsmArtifacts(currentArtifact, {
          artifactState: ArtifactState.NEW,
          config: {
            type: routingType,
            owner: address2,
            domains: {},
          },
        });

        assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');
        expect(result.config.type).to.equal(routingType);
        expect(result.deployed.address).to.equal(address1);
      });
    }

    it('should return DEPLOYED when domain ISMs are unchanged', () => {
      const domainIsmConfig: MultisigIsmConfig = {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      };

      const currentConfig: RoutingIsmArtifactConfig = {
        type: 'domainRoutingIsm',
        owner: address1,
        domains: {
          [domain1]: {
            artifactState: ArtifactState.DEPLOYED,
            config: domainIsmConfig,
            deployed: { address: address2 },
          },
        },
      };

      const currentArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: currentConfig,
        deployed: { address: address1 },
      };

      const expectedConfig: RoutingIsmArtifactConfig = {
        type: 'domainRoutingIsm',
        owner: address1,
        domains: {
          [domain1]: {
            artifactState: ArtifactState.NEW,
            config: domainIsmConfig, // Same config
          },
        },
      };

      const result = mergeIsmArtifacts(currentArtifact, {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      });

      expect(isArtifactDeployed(result)).to.be.true;
      assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');
      expect(result.config.type).to.equal('domainRoutingIsm');
      expect(result.deployed.address).to.equal(address1);

      const resultConfig = result.config as RoutingIsmArtifactConfig;
      const domain1Ism = getDomainIsm(resultConfig, domain1);
      expect(isArtifactDeployed(domain1Ism)).to.be.true;
      assert(isArtifactDeployed(domain1Ism), 'Expected DEPLOYED domain ISM');
      expect(domain1Ism.deployed.address).to.equal(address2);
    });

    it('should mark domain ISM as NEW when its config changes', () => {
      const currentArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: address1,
          domains: {
            [domain1]: {
              artifactState: ArtifactState.DEPLOYED,
              config: {
                type: 'merkleRootMultisigIsm',
                validators: [validator1, validator2],
                threshold: 2,
              },
              deployed: { address: address2 },
            },
          },
        },
        deployed: { address: address1 },
      };

      const expectedConfig: RoutingIsmArtifactConfig = {
        type: 'domainRoutingIsm',
        owner: address1,
        domains: {
          [domain1]: {
            artifactState: ArtifactState.NEW,
            config: {
              type: 'merkleRootMultisigIsm',
              validators: [validator1, validator3], // Different validator
              threshold: 2,
            },
          },
        },
      };

      const result = mergeIsmArtifacts(currentArtifact, {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      });

      expect(isArtifactDeployed(result)).to.be.true;
      assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');
      const resultConfig = result.config as RoutingIsmArtifactConfig;
      const domain1Ism = getDomainIsm(resultConfig, domain1);

      // Domain ISM config changed, should be NEW
      expect(isArtifactNew(domain1Ism)).to.be.true;
      assert(isArtifactNew(domain1Ism), 'Expected NEW domain ISM');
      expect((domain1Ism.config as MultisigIsmConfig).validators).to.deep.equal(
        [validator1, validator3],
      );
    });

    it('should mark newly added domain ISM as NEW', () => {
      const currentArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: address1,
          domains: {
            [domain1]: {
              artifactState: ArtifactState.DEPLOYED,
              config: {
                type: 'merkleRootMultisigIsm',
                validators: [validator1, validator2],
                threshold: 2,
              },
              deployed: { address: address2 },
            },
          },
        },
        deployed: { address: address1 },
      };

      const newDomainConfig: IsmArtifactConfig = {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      };

      const expectedConfig: RoutingIsmArtifactConfig = {
        type: 'domainRoutingIsm',
        owner: address1,
        domains: {
          [domain1]: {
            artifactState: ArtifactState.NEW,
            config: {
              type: 'merkleRootMultisigIsm',
              validators: [validator1, validator2],
              threshold: 2,
            },
          },
          [domain2]: {
            // New domain
            artifactState: ArtifactState.NEW,
            config: newDomainConfig,
          },
        },
      };

      const result = mergeIsmArtifacts(currentArtifact, {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      });

      expect(isArtifactDeployed(result)).to.be.true;
      assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');
      const resultConfig = result.config as RoutingIsmArtifactConfig;

      // Domain 1 should be DEPLOYED (unchanged)
      const domain1Ism = getDomainIsm(resultConfig, domain1);
      expect(isArtifactDeployed(domain1Ism)).to.be.true;
      assert(isArtifactDeployed(domain1Ism), 'Expected DEPLOYED domain 1 ISM');
      expect(domain1Ism.deployed.address).to.equal(address2);

      // Domain 2 should be NEW
      const domain2Ism = getDomainIsm(resultConfig, domain2);
      expect(isArtifactNew(domain2Ism)).to.be.true;
      assert(isArtifactNew(domain2Ism), 'Expected NEW domain 2 ISM');
      expect(domain2Ism.config).to.deep.equal(newDomainConfig);
    });

    it('should pass through UNDERIVED domain ISMs without modification', () => {
      const currentArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: address1,
          domains: {
            [domain1]: {
              artifactState: ArtifactState.DEPLOYED,
              config: {
                type: 'merkleRootMultisigIsm',
                validators: [validator1, validator2],
                threshold: 2,
              },
              deployed: { address: address2 },
            },
          },
        },
        deployed: { address: address1 },
      };

      const expectedConfig: RoutingIsmArtifactConfig = {
        type: 'domainRoutingIsm',
        owner: address1,
        domains: {
          [domain1]: {
            artifactState: ArtifactState.NEW,
            config: {
              type: 'merkleRootMultisigIsm',
              validators: [validator1, validator2],
              threshold: 2,
            },
          },
          [domain2]: {
            // UNDERIVED domain ISM (address-only reference)
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: address2 },
          },
        },
      };

      const result = mergeIsmArtifacts(currentArtifact, {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      });

      expect(isArtifactDeployed(result)).to.be.true;
      assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');
      const resultConfig = result.config as RoutingIsmArtifactConfig;

      // Domain 1 should be DEPLOYED (unchanged)
      const domain1Ism = getDomainIsm(resultConfig, domain1);
      expect(isArtifactDeployed(domain1Ism)).to.be.true;
      assert(isArtifactDeployed(domain1Ism), 'Expected DEPLOYED domain 1 ISM');

      // Domain 2 should be UNDERIVED (passed through as-is)
      const domain2Ism = getDomainIsm(resultConfig, domain2);
      expect(isArtifactUnderived(domain2Ism)).to.be.true;
      assert(
        isArtifactUnderived(domain2Ism),
        'Expected UNDERIVED domain 2 ISM',
      );
      expect(domain2Ism.deployed.address).to.equal(address2);
    });

    it('should allow owner change without redeployment (mutable property)', () => {
      const domainIsmConfig: MultisigIsmConfig = {
        type: 'merkleRootMultisigIsm',
        validators: [validator1, validator2],
        threshold: 2,
      };

      const currentArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: address1, // Old owner
          domains: {
            [domain1]: {
              artifactState: ArtifactState.DEPLOYED,
              config: domainIsmConfig,
              deployed: { address: address2 },
            },
          },
        },
        deployed: { address: address1 },
      };

      const expectedConfig: RoutingIsmArtifactConfig = {
        type: 'domainRoutingIsm',
        owner: address2, // New owner (different!)
        domains: {
          [domain1]: {
            artifactState: ArtifactState.NEW,
            config: domainIsmConfig, // Same domain config
          },
        },
      };

      const result = mergeIsmArtifacts(currentArtifact, {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      });

      // Should stay DEPLOYED (owner is mutable, no redeployment needed)
      expect(isArtifactDeployed(result)).to.be.true;
      assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');

      // Should reuse existing address
      expect(result.deployed.address).to.equal(address1);

      const resultConfig = result.config as RoutingIsmArtifactConfig;

      // Owner should be updated to expected
      expect(resultConfig.owner).to.equal(address2);

      // Domain ISM should be DEPLOYED (unchanged)
      const domain1Ism = getDomainIsm(resultConfig, domain1);
      expect(isArtifactDeployed(domain1Ism)).to.be.true;
      assert(isArtifactDeployed(domain1Ism), 'Expected DEPLOYED domain ISM');
      expect(domain1Ism.deployed.address).to.equal(address2);
    });

    it('should remove domains not present in expected config', () => {
      const currentArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: address1,
          domains: {
            [domain1]: {
              artifactState: ArtifactState.DEPLOYED,
              config: {
                type: 'merkleRootMultisigIsm',
                validators: [validator1, validator2],
                threshold: 2,
              },
              deployed: { address: address2 },
            },
            [domain2]: {
              // This domain will be removed
              artifactState: ArtifactState.DEPLOYED,
              config: {
                type: 'merkleRootMultisigIsm',
                validators: [validator1, validator3],
                threshold: 2,
              },
              deployed: { address: address2 },
            },
          },
        },
        deployed: { address: address1 },
      };

      const expectedConfig: RoutingIsmArtifactConfig = {
        type: 'domainRoutingIsm',
        owner: address1,
        domains: {
          [domain1]: {
            // Only domain 1 is in expected config
            artifactState: ArtifactState.NEW,
            config: {
              type: 'merkleRootMultisigIsm',
              validators: [validator1, validator2],
              threshold: 2,
            },
          },
          // Domain 2 is omitted - should be removed
        },
      };

      const result = mergeIsmArtifacts(currentArtifact, {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      });

      expect(isArtifactDeployed(result)).to.be.true;
      assert(isArtifactDeployed(result), 'Expected DEPLOYED artifact');

      const resultConfig = result.config as RoutingIsmArtifactConfig;

      // Should only have domain 1
      expect(Object.keys(resultConfig.domains)).to.deep.equal(['1']);
      expect(resultConfig.domains[domain1]).to.exist;
      expect(resultConfig.domains[domain2]).to.be.undefined;
    });
  });
});
