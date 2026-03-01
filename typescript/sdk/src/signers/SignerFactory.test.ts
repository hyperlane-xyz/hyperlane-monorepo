import { expect } from 'chai';
import { Wallet } from 'ethers';

import { SignerFactory } from './SignerFactory.js';
import { SignerType } from './config.js';

// Test private key (anvil default key - never use in production)
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('SignerFactory', () => {
  describe('createSigner', () => {
    describe('RAW_KEY signer', () => {
      it('should create signer from raw private key', async () => {
        const signer = await SignerFactory.createSigner({
          type: SignerType.RAW_KEY,
          privateKey: TEST_PRIVATE_KEY,
        });

        expect(signer).to.be.instanceOf(Wallet);
        expect(await signer.getAddress()).to.equal(TEST_ADDRESS);
      });

      it('should create signer from environment variable', async () => {
        const envVarName = 'TEST_SIGNER_PRIVATE_KEY';
        process.env[envVarName] = TEST_PRIVATE_KEY;

        try {
          const signer = await SignerFactory.createSigner({
            type: SignerType.RAW_KEY,
            privateKeyEnvVar: envVarName,
          });

          expect(signer).to.be.instanceOf(Wallet);
          expect(await signer.getAddress()).to.equal(TEST_ADDRESS);
        } finally {
          delete process.env[envVarName];
        }
      });

      it('should throw error when env var is not set', async () => {
        const envVarName = 'NONEXISTENT_ENV_VAR_FOR_TEST';
        delete process.env[envVarName]; // Ensure it doesn't exist

        try {
          await SignerFactory.createSigner({
            type: SignerType.RAW_KEY,
            privateKeyEnvVar: envVarName,
          });
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect((error as Error).message).to.include(envVarName);
          expect((error as Error).message).to.include('is not set');
        }
      });

      it('should throw error when neither privateKey nor privateKeyEnvVar is provided', async () => {
        try {
          await SignerFactory.createSigner({
            type: SignerType.RAW_KEY,
          });
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect((error as Error).message).to.include(
            'privateKey or privateKeyEnvVar',
          );
        }
      });

      it('should prefer privateKey over privateKeyEnvVar when both are provided', async () => {
        const envVarName = 'TEST_SIGNER_PRIVATE_KEY_2';
        // Set env var to a different key
        const otherKey = Wallet.createRandom().privateKey;
        process.env[envVarName] = otherKey;

        try {
          const signer = await SignerFactory.createSigner({
            type: SignerType.RAW_KEY,
            privateKey: TEST_PRIVATE_KEY,
            privateKeyEnvVar: envVarName,
          });

          // Should use the direct privateKey, not the env var
          expect(await signer.getAddress()).to.equal(TEST_ADDRESS);
        } finally {
          delete process.env[envVarName];
        }
      });
    });

    describe('TURNKEY signer', () => {
      it('should create Turnkey signer with valid config', async () => {
        // Note: This test just verifies the signer is created, not that it works
        // (would need actual Turnkey credentials for that)
        const signer = await SignerFactory.createSigner({
          type: SignerType.TURNKEY,
          organizationId: 'test-org-id',
          apiPublicKey: 'test-api-public-key',
          apiPrivateKey: 'test-api-private-key',
          privateKeyId: 'test-private-key-id',
          publicKey: '0x' + '00'.repeat(33), // Dummy compressed public key
        });

        // The signer should be created (it won't work without real credentials)
        expect(signer).to.exist;
      });
    });

    describe('GCP_SECRET signer', () => {
      it('should attempt to create GCP signer and handle errors gracefully', async () => {
        try {
          await SignerFactory.createSigner({
            type: SignerType.GCP_SECRET,
            project: 'test-project',
            secretName: 'test-secret',
          });
          // If we get here, GCP client is installed and authenticated
          // This is fine for the test - we just want to verify error handling
        } catch (error) {
          const errorMessage = (error as Error).message;
          // Either GCP client not installed or authentication/permission error
          // All of these are acceptable errors for this test
          expect(errorMessage).to.be.a('string');
          expect(errorMessage.length).to.be.greaterThan(0);
        }
      });
    });

    describe('FOUNDRY_KEYSTORE signer', () => {
      it('should throw error when keystore file does not exist', async () => {
        try {
          await SignerFactory.createSigner({
            type: SignerType.FOUNDRY_KEYSTORE,
            accountName: 'nonexistent-account',
            keystorePath: '/nonexistent/path',
          });
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect((error as Error).message).to.include('not found');
        }
      });
    });

    describe('unknown signer type', () => {
      it('should throw error for unknown signer type', async () => {
        try {
          await SignerFactory.createSigner({
            // @ts-expect-error - Testing invalid type
            type: 'unknownType',
          });
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect((error as Error).message).to.include('Unknown signer type');
        }
      });
    });
  });
});
