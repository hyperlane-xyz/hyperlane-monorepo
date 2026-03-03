import { expect } from 'chai';

import {
  SignerType,
  SignerConfigSchema,
  SignerConfigurationSchema,
  SignerRefSchema,
  isSignerRef,
} from './config.js';

// Valid 32-byte hex private key (64 hex chars after 0x)
const VALID_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('Signer Config Schemas', () => {
  describe('SignerConfigSchema', () => {
    describe('RAW_KEY type', () => {
      it('should accept valid rawKey config with privateKey', () => {
        const config = {
          type: SignerType.RAW_KEY,
          privateKey: VALID_PRIVATE_KEY,
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });

      it('should accept valid rawKey config with privateKeyEnvVar', () => {
        const config = {
          type: SignerType.RAW_KEY,
          privateKeyEnvVar: 'MY_PRIVATE_KEY',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });

      it('should accept rawKey config with both privateKey and privateKeyEnvVar', () => {
        const config = {
          type: SignerType.RAW_KEY,
          privateKey: VALID_PRIVATE_KEY,
          privateKeyEnvVar: 'MY_KEY',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });

      it('should accept rawKey config with neither (validation happens at runtime)', () => {
        const config = {
          type: SignerType.RAW_KEY,
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });

      it('should reject invalid privateKey format', () => {
        const config = {
          type: SignerType.RAW_KEY,
          privateKey: 'not-a-valid-key',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.false;
      });
    });

    describe('TURNKEY type', () => {
      it('should accept valid turnkey config', () => {
        const config = {
          type: SignerType.TURNKEY,
          organizationId: 'org-123',
          apiPublicKey: 'pub-key',
          apiPrivateKey: 'priv-key',
          privateKeyId: 'key-id',
          publicKey: '0x04abcd',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });

      it('should reject turnkey config missing required fields', () => {
        const config = {
          type: SignerType.TURNKEY,
          organizationId: 'org-123',
          // Missing other required fields
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.false;
      });

      it('should accept turnkey config with optional apiBaseUrl', () => {
        const config = {
          type: SignerType.TURNKEY,
          organizationId: 'org-123',
          apiPublicKey: 'pub-key',
          apiPrivateKey: 'priv-key',
          privateKeyId: 'key-id',
          publicKey: '0x04abcd',
          apiBaseUrl: 'https://custom.turnkey.com',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });
    });

    describe('GCP_SECRET type', () => {
      it('should accept valid GCP secret config', () => {
        const config = {
          type: SignerType.GCP_SECRET,
          project: 'my-project',
          secretName: 'my-secret',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });

      it('should reject GCP config missing project', () => {
        const config = {
          type: SignerType.GCP_SECRET,
          secretName: 'my-secret',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.false;
      });

      it('should reject GCP config missing secretName', () => {
        const config = {
          type: SignerType.GCP_SECRET,
          project: 'my-project',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.false;
      });
    });

    describe('FOUNDRY_KEYSTORE type', () => {
      it('should accept valid foundry keystore config', () => {
        const config = {
          type: SignerType.FOUNDRY_KEYSTORE,
          accountName: 'my-account',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });

      it('should accept foundry config with optional fields', () => {
        const config = {
          type: SignerType.FOUNDRY_KEYSTORE,
          accountName: 'my-account',
          keystorePath: '/custom/path',
          passwordEnvVar: 'MY_PASSWORD',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.true;
      });

      it('should reject foundry config missing accountName', () => {
        const config = {
          type: SignerType.FOUNDRY_KEYSTORE,
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.false;
      });
    });

    describe('invalid type', () => {
      it('should reject unknown signer type', () => {
        const config = {
          type: 'unknownType',
        };
        const result = SignerConfigSchema.safeParse(config);
        expect(result.success).to.be.false;
      });
    });
  });

  describe('SignerRefSchema', () => {
    it('should accept valid ref', () => {
      const ref = { ref: 'my-signer' };
      const result = SignerRefSchema.safeParse(ref);
      expect(result.success).to.be.true;
    });

    it('should accept empty ref (validation is not enforced at schema level)', () => {
      // Note: Empty ref will fail at runtime when trying to resolve it
      const ref = { ref: '' };
      const result = SignerRefSchema.safeParse(ref);
      expect(result.success).to.be.true;
    });

    it('should reject missing ref', () => {
      const ref = {};
      const result = SignerRefSchema.safeParse(ref);
      expect(result.success).to.be.false;
    });
  });

  describe('isSignerRef', () => {
    it('should return true for SignerRef objects', () => {
      expect(isSignerRef({ ref: 'my-signer' })).to.be.true;
    });

    it('should return false for SignerConfig objects', () => {
      expect(
        isSignerRef({ type: SignerType.RAW_KEY, privateKey: VALID_PRIVATE_KEY }),
      ).to.be.false;
    });

    // Note: isSignerRef assumes valid input from SignerOrRef union
    // It doesn't handle null/undefined/non-objects as those should never
    // reach this function when used with proper TypeScript types
  });

  describe('SignerConfigurationSchema', () => {
    it('should accept valid configuration with signers and defaults', () => {
      const config = {
        signers: {
          dev: {
            type: SignerType.RAW_KEY,
            privateKeyEnvVar: 'DEV_KEY',
          },
          prod: {
            type: SignerType.GCP_SECRET,
            project: 'my-project',
            secretName: 'prod-key',
          },
        },
        defaults: {
          default: { ref: 'dev' },
          chains: {
            ethereum: { ref: 'prod' },
          },
        },
      };
      const result = SignerConfigurationSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should accept configuration with only signers', () => {
      const config = {
        signers: {
          dev: {
            type: SignerType.RAW_KEY,
            privateKey: VALID_PRIVATE_KEY,
          },
        },
      };
      const result = SignerConfigurationSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should accept configuration with only defaults', () => {
      const config = {
        defaults: {
          default: {
            type: SignerType.RAW_KEY,
            privateKey: VALID_PRIVATE_KEY,
          },
        },
      };
      const result = SignerConfigurationSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should accept empty configuration', () => {
      const config = {};
      const result = SignerConfigurationSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should accept defaults with protocol-specific signers', () => {
      const config = {
        signers: {
          evm: { type: SignerType.RAW_KEY, privateKey: VALID_PRIVATE_KEY },
          svm: { type: SignerType.RAW_KEY, privateKey: VALID_PRIVATE_KEY },
        },
        defaults: {
          protocols: {
            ethereum: { ref: 'evm' },
            sealevel: { ref: 'svm' },
          },
        },
      };
      const result = SignerConfigurationSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should accept inline signer config in defaults', () => {
      const config = {
        defaults: {
          default: {
            type: SignerType.RAW_KEY,
            privateKey: VALID_PRIVATE_KEY,
          },
          chains: {
            ethereum: {
              type: SignerType.GCP_SECRET,
              project: 'prod',
              secretName: 'eth-key',
            },
          },
        },
      };
      const result = SignerConfigurationSchema.safeParse(config);
      expect(result.success).to.be.true;
    });
  });
});
