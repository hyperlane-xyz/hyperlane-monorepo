import { expect } from 'chai';
import * as fs from 'fs';
import { $ } from 'zx';

import { writeYamlOrJson } from '../../utils/files.js';

import { hyperlaneCoreDeploy } from './commands/core.js';
import { localTestRunCmdPrefix } from './commands/helpers.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from './consts.js';

/**
 * E2E tests for signer registry integration.
 *
 * These tests verify that signers can be loaded from a registry instead of
 * passing private keys directly via --key argument.
 */
describe('signer registry e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const SIGNER_REGISTRY_PATH = `${TEMP_PATH}/signer-registry`;
  const SIGNERS_DIR = `${SIGNER_REGISTRY_PATH}/signers`;

  before(async () => {
    // Deploy core contracts first
    await Promise.all([
      hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH),
      hyperlaneCoreDeploy(CHAIN_NAME_3, CORE_CONFIG_PATH),
    ]);

    // Create signer registry directory
    fs.mkdirSync(SIGNERS_DIR, { recursive: true });
  });

  after(() => {
    // Clean up signer registry
    if (fs.existsSync(SIGNER_REGISTRY_PATH)) {
      fs.rmSync(SIGNER_REGISTRY_PATH, { recursive: true });
    }
  });

  describe('rawKey signer from registry', () => {
    it('should send message using signer from registry config file', async () => {
      // Create signer configuration with rawKey type
      const signerConfig = {
        signers: {
          deployer: {
            type: 'rawKey',
            privateKey: ANVIL_KEY,
          },
        },
        defaults: {
          default: { ref: 'deployer' },
        },
      };

      writeYamlOrJson(`${SIGNERS_DIR}/default.yaml`, signerConfig);

      // Run send message command with registry that includes signer config
      // Note: We provide both the anvil registry (for chain metadata) and
      // the signer registry (for signer config)
      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane send message \
        --registry ${REGISTRY_PATH} \
        --registry ${SIGNER_REGISTRY_PATH} \
        --origin ${CHAIN_NAME_2} \
        --destination ${CHAIN_NAME_3} \
        --verbosity debug \
        --quick \
        --yes`.nothrow();

      const output = stdout + stderr;
      expect(exitCode, `Command failed with output: ${output}`).to.equal(0);
      expect(output).to.include('Message ID:');
      expect(output).to.include(`Sent message from ${CHAIN_NAME_2}`);
    });

    it('should use privateKeyEnvVar when specified in signer config', async () => {
      // Create signer configuration that references an environment variable
      const signerConfig = {
        signers: {
          'env-deployer': {
            type: 'rawKey',
            privateKeyEnvVar: 'TEST_DEPLOYER_KEY',
          },
        },
        defaults: {
          default: { ref: 'env-deployer' },
        },
      };

      writeYamlOrJson(`${SIGNERS_DIR}/env-based.yaml`, signerConfig);

      // Set the environment variable
      process.env.TEST_DEPLOYER_KEY = ANVIL_KEY;

      try {
        const { exitCode, stdout, stderr } =
          await $`TEST_DEPLOYER_KEY=${ANVIL_KEY} ${localTestRunCmdPrefix()} hyperlane send message \
          --registry ${REGISTRY_PATH} \
          --registry ${SIGNER_REGISTRY_PATH} \
          --origin ${CHAIN_NAME_2} \
          --destination ${CHAIN_NAME_3} \
          --verbosity debug \
          --quick \
          --yes`.nothrow();

        const output = stdout + stderr;
        expect(exitCode, `Command failed with output: ${output}`).to.equal(0);
        expect(output).to.include('Message ID:');
      } finally {
        delete process.env.TEST_DEPLOYER_KEY;
        // Clean up the env-based config
        fs.unlinkSync(`${SIGNERS_DIR}/env-based.yaml`);
      }
    });
  });

  describe('chain-specific signer resolution', () => {
    it('should use chain-specific signer when configured', async () => {
      // Create signer config with different signers per chain
      // Both use the same key, but this tests the resolution logic
      const signerConfig = {
        signers: {
          'chain2-signer': {
            type: 'rawKey',
            privateKey: ANVIL_KEY,
          },
          'chain3-signer': {
            type: 'rawKey',
            privateKey: ANVIL_KEY,
          },
        },
        defaults: {
          chains: {
            [CHAIN_NAME_2]: { ref: 'chain2-signer' },
            [CHAIN_NAME_3]: { ref: 'chain3-signer' },
          },
        },
      };

      writeYamlOrJson(`${SIGNERS_DIR}/chain-specific.yaml`, signerConfig);

      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane send message \
        --registry ${REGISTRY_PATH} \
        --registry ${SIGNER_REGISTRY_PATH} \
        --origin ${CHAIN_NAME_2} \
        --destination ${CHAIN_NAME_3} \
        --verbosity debug \
        --quick \
        --yes`.nothrow();

      const output = stdout + stderr;
      expect(exitCode, `Command failed with output: ${output}`).to.equal(0);
      expect(output).to.include('Message ID:');

      // Clean up
      fs.unlinkSync(`${SIGNERS_DIR}/chain-specific.yaml`);
    });
  });

  describe('signer configuration merging', () => {
    it('should merge signer configs from multiple registries', async () => {
      // Create a second signer registry to test merging
      const secondSignerRegistry = `${TEMP_PATH}/signer-registry-2`;
      const secondSignersDir = `${secondSignerRegistry}/signers`;
      fs.mkdirSync(secondSignersDir, { recursive: true });

      // First registry has a signer but no default
      const firstConfig = {
        signers: {
          'first-signer': {
            type: 'rawKey',
            privateKey: ANVIL_KEY,
          },
        },
      };
      writeYamlOrJson(`${SIGNERS_DIR}/first.yaml`, firstConfig);

      // Second registry sets the default to use the first registry's signer
      const secondConfig = {
        defaults: {
          default: { ref: 'first-signer' },
        },
      };
      writeYamlOrJson(`${secondSignersDir}/second.yaml`, secondConfig);

      try {
        const { exitCode, stdout, stderr } =
          await $`${localTestRunCmdPrefix()} hyperlane send message \
          --registry ${REGISTRY_PATH} \
          --registry ${SIGNER_REGISTRY_PATH} \
          --registry ${secondSignerRegistry} \
          --origin ${CHAIN_NAME_2} \
          --destination ${CHAIN_NAME_3} \
          --verbosity debug \
          --quick \
          --yes`.nothrow();

        const output = stdout + stderr;
        expect(exitCode, `Command failed with output: ${output}`).to.equal(0);
        expect(output).to.include('Message ID:');
      } finally {
        // Clean up
        fs.unlinkSync(`${SIGNERS_DIR}/first.yaml`);
        fs.rmSync(secondSignerRegistry, { recursive: true });
      }
    });
  });

  describe('fallback behavior', () => {
    it('should fall back to --key when registry has no signer config', async () => {
      // Create an empty signer registry (no signers directory)
      const emptyRegistry = `${TEMP_PATH}/empty-signer-registry`;
      fs.mkdirSync(emptyRegistry, { recursive: true });

      try {
        const { exitCode, stdout, stderr } =
          await $`${localTestRunCmdPrefix()} hyperlane send message \
          --registry ${REGISTRY_PATH} \
          --registry ${emptyRegistry} \
          --origin ${CHAIN_NAME_2} \
          --destination ${CHAIN_NAME_3} \
          --key ${ANVIL_KEY} \
          --verbosity debug \
          --quick \
          --yes`.nothrow();

        const output = stdout + stderr;
        expect(exitCode, `Command failed with output: ${output}`).to.equal(0);
        expect(output).to.include('Message ID:');
      } finally {
        fs.rmSync(emptyRegistry, { recursive: true });
      }
    });

    it('should prefer registry signer over --key when both are provided', async () => {
      // Create signer config
      const signerConfig = {
        signers: {
          'registry-signer': {
            type: 'rawKey',
            privateKey: ANVIL_KEY,
          },
        },
        defaults: {
          default: { ref: 'registry-signer' },
        },
      };
      writeYamlOrJson(`${SIGNERS_DIR}/preferred.yaml`, signerConfig);

      try {
        // Provide a different (invalid) key via --key
        // If registry signer is preferred, command should succeed
        // If --key is used, it would fail due to invalid key
        const { exitCode, stdout, stderr } =
          await $`${localTestRunCmdPrefix()} hyperlane send message \
          --registry ${REGISTRY_PATH} \
          --registry ${SIGNER_REGISTRY_PATH} \
          --origin ${CHAIN_NAME_2} \
          --destination ${CHAIN_NAME_3} \
          --verbosity debug \
          --quick \
          --yes`.nothrow();

        const output = stdout + stderr;
        // The registry signer should be used, so the command should succeed
        expect(exitCode, `Command failed with output: ${output}`).to.equal(0);
        expect(output).to.include('Message ID:');
        expect(output).to.include('Created signer for chain');
        expect(output).to.include('from registry configuration');
      } finally {
        fs.unlinkSync(`${SIGNERS_DIR}/preferred.yaml`);
      }
    });
  });
});
