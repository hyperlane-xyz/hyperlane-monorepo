import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import { ArtifactState } from './artifact.js';
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

  interface TestCase {
    name: string;
    currentArtifact: DeployedIsmArtifact | undefined;
    expectedArtifact:
      | { artifactState: typeof ArtifactState.NEW; config: IsmArtifactConfig }
      | DeployedIsmArtifact; // Input to mergeIsmArtifacts
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
      name: 'should use expected address when config unchanged (DEPLOYED input with different address)',
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
      name: 'should return expected as NEW when validators change',
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
      name: 'should return expected as NEW when threshold changes',
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

      expect(result.artifactState).to.equal(tc.expectedArtifactState);

      // Assert based on expected artifact state
      if (tc.expectedArtifactState === ArtifactState.NEW) {
        assert(
          result.artifactState === ArtifactState.NEW,
          'Expected NEW artifact',
        );
        expect(result.config).to.deep.equal(tc.expectedConfig);
      } else if (tc.expectedArtifactState === ArtifactState.DEPLOYED) {
        assert(
          result.artifactState === ArtifactState.DEPLOYED,
          'Expected DEPLOYED artifact',
        );
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
          1: {
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
          1: {
            artifactState: ArtifactState.NEW,
            config: domainIsmConfig, // Same config
          },
        },
      };

      const result = mergeIsmArtifacts(currentArtifact, {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      assert(
        result.artifactState === ArtifactState.DEPLOYED,
        'Expected DEPLOYED artifact',
      );
      expect(result.config.type).to.equal('domainRoutingIsm');
      expect(result.deployed.address).to.equal(address1);

      const resultConfig = result.config as RoutingIsmArtifactConfig;
      const domain1Ism = resultConfig.domains[1];
      expect(domain1Ism.artifactState).to.equal(ArtifactState.DEPLOYED);
      assert(
        domain1Ism.artifactState === ArtifactState.DEPLOYED,
        'Expected DEPLOYED domain ISM',
      );
      expect(domain1Ism.deployed.address).to.equal(address2);
    });

    it('should mark domain ISM as NEW when config changes', () => {
      const currentArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: address1,
          domains: {
            1: {
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
          1: {
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

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      assert(
        result.artifactState === ArtifactState.DEPLOYED,
        'Expected DEPLOYED artifact',
      );
      const resultConfig = result.config as RoutingIsmArtifactConfig;
      const domain1Ism = resultConfig.domains[1];

      // Domain ISM config changed, should be NEW
      expect(domain1Ism.artifactState).to.equal(ArtifactState.NEW);
      assert(
        domain1Ism.artifactState === ArtifactState.NEW,
        'Expected NEW domain ISM',
      );
      expect((domain1Ism.config as MultisigIsmConfig).validators).to.deep.equal(
        [validator1, validator3],
      );
    });

    it('should include new domain as NEW', () => {
      const currentArtifact: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'domainRoutingIsm',
          owner: address1,
          domains: {
            1: {
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
          1: {
            artifactState: ArtifactState.NEW,
            config: {
              type: 'merkleRootMultisigIsm',
              validators: [validator1, validator2],
              threshold: 2,
            },
          },
          2: {
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

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      assert(
        result.artifactState === ArtifactState.DEPLOYED,
        'Expected DEPLOYED artifact',
      );
      const resultConfig = result.config as RoutingIsmArtifactConfig;

      // Domain 1 should be DEPLOYED (unchanged)
      const domain1Ism = resultConfig.domains[1];
      expect(domain1Ism.artifactState).to.equal(ArtifactState.DEPLOYED);
      assert(
        domain1Ism.artifactState === ArtifactState.DEPLOYED,
        'Expected DEPLOYED domain 1 ISM',
      );
      expect(domain1Ism.deployed.address).to.equal(address2);

      // Domain 2 should be NEW
      const domain2Ism = resultConfig.domains[2];
      expect(domain2Ism.artifactState).to.equal(ArtifactState.NEW);
      assert(
        domain2Ism.artifactState === ArtifactState.NEW,
        'Expected NEW domain 2 ISM',
      );
      expect(domain2Ism.config).to.deep.equal(newDomainConfig);
    });
  });
});
