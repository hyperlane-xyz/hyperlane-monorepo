import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import {
  ArtifactNew,
  ArtifactState,
  isArtifactDeployed,
  isArtifactNew,
  isArtifactUnderived,
} from './artifact.js';
import {
  DeployedIsmArtifact,
  IsmArtifactConfig,
  MultisigIsmConfig,
  RoutingIsmArtifactConfig,
  mergeIsmArtifacts,
} from './ism.js';

describe('mergeIsmArtifacts', () => {
  const address1 = '0x1111111111111111111111111111111111111111';
  const address2 = '0x2222222222222222222222222222222222222222';
  const validator1 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const validator2 = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const validator3 = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const domain1 = 1;
  const domain2 = 2;

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

  // Routing ISM tests (more complex, kept separate)
  describe('Routing ISM', () => {
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
      const domain1Ism = resultConfig.domains[domain1];
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
      const domain1Ism = resultConfig.domains[domain1];

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
      const domain1Ism = resultConfig.domains[domain1];
      expect(isArtifactDeployed(domain1Ism)).to.be.true;
      assert(isArtifactDeployed(domain1Ism), 'Expected DEPLOYED domain 1 ISM');
      expect(domain1Ism.deployed.address).to.equal(address2);

      // Domain 2 should be NEW
      const domain2Ism = resultConfig.domains[domain2];
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
      const domain1Ism = resultConfig.domains[domain1];
      expect(isArtifactDeployed(domain1Ism)).to.be.true;
      assert(isArtifactDeployed(domain1Ism), 'Expected DEPLOYED domain 1 ISM');

      // Domain 2 should be UNDERIVED (passed through as-is)
      const domain2Ism = resultConfig.domains[domain2];
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
      const domain1Ism = resultConfig.domains[domain1];
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
