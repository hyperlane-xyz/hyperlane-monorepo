import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { type HookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import {
  type DerivedWarpRouteDeployConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJsonOrThrow, writeYamlOrJson } from '../../utils/files.js';
import { type HyperlaneE2EWarpTestCommands } from '../commands/warp.js';

/**
 * Configuration for Hook update test suite
 */
export interface HookUpdateTestConfig {
  protocol: ProtocolType;
  chainName: string;
  baseWarpConfig: WarpRouteDeployConfig;
  privateKey: string;
  warpRoutePath: string;
  warpDeployPath: string;
  warpRouteId: string;
  warpReadOutputPath: string;
  otherOwnerAddress: string;
  /**
   * Optional map of test names to skip flags
   * Set to true to skip a specific test
   */
  skipTests?: {
    updateDefaultHookToMerkleTreeHook?: boolean;
    updateMerkleTreeHookToIgpHook?: boolean;
    updateMerkleTreeHookToDefaultHook?: boolean;
    updateIgpHookGasConfigs?: boolean;
    hookUpdateIdempotency?: boolean;
    updateIgpHookOwner?: boolean;
  };
}

/**
 * Creates a reusable Hook update test suite for AltVM protocols
 */
export function createHookUpdateTests(
  config: HookUpdateTestConfig,
  warpCommands: HyperlaneE2EWarpTestCommands,
): void {
  let warpDeployConfig: WarpRouteDeployConfig;

  describe('Hook updates', () => {
    beforeEach(async () => {
      // Deploy warp route without Hook initially
      warpDeployConfig = config.baseWarpConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);
      await warpCommands.deployRaw({
        warpRouteId: config.warpRouteId,
        skipConfirmationPrompts: true,
        privateKey: config.privateKey,
      });
    });

    it('should update Hook from nothing to MerkleTreeHook', async function () {
      if (config.skipTests?.updateDefaultHookToMerkleTreeHook) {
        this.skip();
        return;
      }

      // Update config to add MerkleTree hook
      warpDeployConfig[config.chainName].hook = {
        type: AltVM.HookType.MERKLE_TREE,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read back the config and verify Hook was set
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const updatedWarpDeployConfig =
        readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
          config.warpReadOutputPath,
        );

      const hookConfig = updatedWarpDeployConfig[config.chainName].hook;

      assert(hookConfig, 'Hook config should be defined');
      assert(
        typeof hookConfig !== 'string',
        'Hook should not be an address string',
      );
      assert(
        hookConfig.type === AltVM.HookType.MERKLE_TREE,
        `Expected Hook type to be ${AltVM.HookType.MERKLE_TREE}, got ${hookConfig.type}`,
      );
      expect(hookConfig.address).to.be.a('string');
    });

    it('should update Hook from MerkleTree to IGP', async function () {
      if (config.skipTests?.updateMerkleTreeHookToIgpHook) {
        this.skip();
        return;
      }

      // First set MerkleTree hook
      warpDeployConfig[config.chainName].hook = {
        type: AltVM.HookType.MERKLE_TREE,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      const newHookConfig: HookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: warpDeployConfig[config.chainName].owner,
        beneficiary: warpDeployConfig[config.chainName].owner,
        oracleKey: warpDeployConfig[config.chainName].owner,
        overhead: {
          [config.chainName]: 50000,
        },
        oracleConfig: {
          [config.chainName]: {
            gasPrice: '1',
            tokenExchangeRate: '1',
          },
        },
      };

      // Now update to IGP hook
      warpDeployConfig[config.chainName].hook = newHookConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read back and verify the new Hook type
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const updatedWarpDeployConfig =
        readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
          config.warpReadOutputPath,
        );

      const hookConfig = updatedWarpDeployConfig[config.chainName].hook;

      assert(hookConfig, 'Hook config should be defined');
      assert(
        typeof hookConfig !== 'string',
        'Hook should not be an address string',
      );
      assert(
        hookConfig.type === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        `Expected Hook type to be ${AltVM.HookType.INTERCHAIN_GAS_PAYMASTER}, got ${hookConfig.type}`,
      );
      expect(hookConfig.address).to.be.a('string');
      expect(hookConfig.owner).to.equal(newHookConfig.owner);
    });

    it('should update Hook from MerkleTree to nothing (unset)', async function () {
      if (config.skipTests?.updateMerkleTreeHookToDefaultHook) {
        this.skip();
        return;
      }

      // First set MerkleTree hook
      warpDeployConfig[config.chainName].hook = {
        type: AltVM.HookType.MERKLE_TREE,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Verify Hook was set
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      let updatedWarpDeployConfig =
        readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
          config.warpReadOutputPath,
        );

      expect(updatedWarpDeployConfig[config.chainName].hook).to.not.be
        .undefined;

      // Now remove the Hook
      delete warpDeployConfig[config.chainName].hook;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read back and verify Hook was unset
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      updatedWarpDeployConfig =
        readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
          config.warpReadOutputPath,
        );

      const hookConfig = updatedWarpDeployConfig[config.chainName].hook;

      // Hook should be reset to zero address
      expect(hookConfig).to.equal('0x0000000000000000000000000000000000000000');
    });

    it('should update IGP Hook gas configs without redeployment', async function () {
      if (config.skipTests?.updateIgpHookGasConfigs) {
        this.skip();
        return;
      }

      // First deploy IGP hook
      const initialHookConfig: HookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: warpDeployConfig[config.chainName].owner,
        beneficiary: warpDeployConfig[config.chainName].owner,
        oracleKey: warpDeployConfig[config.chainName].owner,
        overhead: {
          [config.chainName]: 50000,
        },
        oracleConfig: {
          [config.chainName]: {
            gasPrice: '1',
            tokenExchangeRate: '1',
          },
        },
      };

      warpDeployConfig[config.chainName].hook = initialHookConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read to get Hook address
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      let updatedWarpDeployConfig =
        readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
          config.warpReadOutputPath,
        );

      const initialHook = updatedWarpDeployConfig[config.chainName].hook;

      assert(
        initialHook && typeof initialHook !== 'string',
        'Initial Hook should be defined',
      );
      assert(
        initialHook.type === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        'Initial Hook should be IGP hook',
      );
      assert(initialHook.address, 'Initial Hook should have address');

      const initialHookAddress = initialHook.address;

      // Now update gas configs
      const updatedHookConfig: HookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: warpDeployConfig[config.chainName].owner,
        beneficiary: warpDeployConfig[config.chainName].owner,
        oracleKey: warpDeployConfig[config.chainName].owner,
        overhead: {
          [config.chainName]: 75000, // Changed overhead
        },
        oracleConfig: {
          [config.chainName]: {
            gasPrice: '2', // Changed gas price
            tokenExchangeRate: '15', // Changed token exchange rate
          },
        },
      };

      warpDeployConfig[config.chainName].hook = updatedHookConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read back and verify:
      // 1. Hook address stayed the same (updated in-place)
      // 2. Gas configs were updated
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      updatedWarpDeployConfig =
        readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
          config.warpReadOutputPath,
        );

      const finalHook = updatedWarpDeployConfig[config.chainName].hook;

      assert(
        finalHook && typeof finalHook !== 'string',
        'Final Hook should be defined',
      );
      assert(
        finalHook.type === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        `Expected Hook type to be ${AltVM.HookType.INTERCHAIN_GAS_PAYMASTER}, got ${finalHook.type}`,
      );
      assert(finalHook.address, 'Final Hook should have address');

      // Hook should NOT be redeployed - same address
      expect(finalHook.address).to.equal(initialHookAddress);

      // Gas configs should be updated
      expect(finalHook.overhead[config.chainName]).to.equal(75000);
      expect(finalHook.oracleConfig[config.chainName].gasPrice).to.equal('2');
      expect(
        finalHook.oracleConfig[config.chainName].tokenExchangeRate,
      ).to.equal('15');
    });

    it('should not redeploy Hook when applying same config twice (idempotency)', async function () {
      if (config.skipTests?.hookUpdateIdempotency) {
        this.skip();
        return;
      }

      // First deployment - set MerkleTree hook
      warpDeployConfig[config.chainName].hook = {
        type: AltVM.HookType.MERKLE_TREE,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read to get Hook address
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const firstConfig = readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
        config.warpReadOutputPath,
      );
      const firstHookConfig = firstConfig[config.chainName].hook;

      assert(
        firstHookConfig,
        'Hook config should be defined after first apply',
      );
      assert(
        typeof firstHookConfig !== 'string',
        'Hook should not be an address string',
      );
      const firstHookAddress = firstHookConfig.address;

      // Apply same config again
      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read again and verify address unchanged
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const secondConfig = readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
        config.warpReadOutputPath,
      );
      const secondHookConfig = secondConfig[config.chainName].hook;

      assert(
        secondHookConfig,
        'Hook config should be defined after second apply',
      );
      assert(
        typeof secondHookConfig !== 'string',
        'Hook should not be an address string',
      );

      // Hook address should be identical (no redeployment)
      expect(secondHookConfig.address).to.equal(firstHookAddress);
      expect(secondHookConfig.type).to.equal(AltVM.HookType.MERKLE_TREE);
    });

    it('should update IGP Hook owner', async function () {
      if (config.skipTests?.updateIgpHookOwner) {
        this.skip();
        return;
      }

      // Deploy IGP hook with initial owner
      const initialOwner = warpDeployConfig[config.chainName].owner;
      const initialHookConfig: HookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: initialOwner,
        beneficiary: initialOwner,
        oracleKey: initialOwner,
        overhead: {
          [config.chainName]: 50000,
        },
        oracleConfig: {
          [config.chainName]: {
            gasPrice: '1',
            tokenExchangeRate: '1',
          },
        },
      };

      warpDeployConfig[config.chainName].hook = initialHookConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read to get first Hook address
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const firstConfig = readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
        config.warpReadOutputPath,
      );
      const firstHookConfig = firstConfig[config.chainName].hook;

      assert(firstHookConfig, 'Hook config should be defined');
      assert(
        typeof firstHookConfig !== 'string',
        'Hook should not be an address string',
      );
      assert(
        firstHookConfig.type === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        `Expected Hook type to be ${AltVM.HookType.INTERCHAIN_GAS_PAYMASTER}, got ${firstHookConfig.type}`,
      );
      const firstHookAddress = firstHookConfig.address;

      // Get a different owner address (use the private key's address for simplicity,
      // assuming it's different from the initial owner)
      // In real tests, you'd provide an alternate owner address
      const newOwner = config.otherOwnerAddress; // This would be a different address in practice

      // Update hook config - change owner
      const updatedHookConfig: HookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: newOwner,
        beneficiary: initialOwner,
        oracleKey: initialOwner,
        overhead: {
          [config.chainName]: 50000,
        },
        oracleConfig: {
          [config.chainName]: {
            gasPrice: '1',
            tokenExchangeRate: '1',
          },
        },
      };

      warpDeployConfig[config.chainName].hook = updatedHookConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read and verify hook was updated (not redeployed)
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const secondConfig = readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
        config.warpReadOutputPath,
      );
      const secondHookConfig = secondConfig[config.chainName].hook;

      assert(secondHookConfig, 'Hook config should be defined after update');
      assert(
        typeof secondHookConfig !== 'string',
        'Hook should not be an address string',
      );
      assert(
        secondHookConfig.type === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        `Expected Hook type to be ${AltVM.HookType.INTERCHAIN_GAS_PAYMASTER}, got ${secondHookConfig.type}`,
      );

      // Hook address should be same (updated in-place)
      expect(secondHookConfig.address).to.equal(firstHookAddress);
      // Owner should be updated
      expect(secondHookConfig.owner).to.equal(newOwner);
    });
  });
}
