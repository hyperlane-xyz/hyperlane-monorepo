import { expect } from 'chai';

import { type IsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import {
  type DerivedWarpRouteDeployConfig,
  IsmType,
  type RoutingIsmConfig,
  type WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  type ProtocolType,
  assert,
  normalizeAddress,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import { type HyperlaneE2ECoreTestCommands } from '../commands/core.js';
import { type HyperlaneE2EWarpTestCommands } from '../commands/warp.js';

/**
 * Configuration for ISM update test suite
 */
export interface IsmUpdateTestConfig {
  protocol: ProtocolType;
  chainName: string;
  baseWarpConfig: WarpRouteDeployConfig;
  privateKey: string;
  warpRoutePath: string;
  warpDeployPath: string;
  warpRouteId: string;
  warpReadOutputPath: string;
  alternateOwnerAddress: Address;
  /**
   * Optional map of test names to skip flags
   * Set to true to skip a specific test
   */
  skipTests?: {
    updateDefaultIsmToTestIsm?: boolean;
    updateTestIsmToMessageIdMultisigIsm?: boolean;
    updateTestIsmToDefaultIsm?: boolean;
    updateMutableRoutingIsm?: boolean;
    ismUpdateIdempotency?: boolean;
    redeployIsmOnStaticConfigChange?: boolean;
  };
}

/**
 * Creates a reusable ISM update test suite for any AltVM protocol (Cosmos, Aleo, Radix)
 */
export function createIsmUpdateTests(
  config: IsmUpdateTestConfig,
  coreCommands: HyperlaneE2ECoreTestCommands,
  warpCommands: HyperlaneE2EWarpTestCommands,
): void {
  let warpDeployConfig: WarpRouteDeployConfig;

  describe('ISM updates', () => {
    beforeEach(async () => {
      // Deploy warp route without ISM initially
      warpDeployConfig = config.baseWarpConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);
      await warpCommands.deployRaw({
        warpRouteId: config.warpRouteId,
        skipConfirmationPrompts: true,
        privateKey: config.privateKey,
      });
    });

    it('should update ISM from nothing to testIsm', async function () {
      if (config.skipTests?.updateDefaultIsmToTestIsm) {
        this.skip();
        return;
      }

      // Update config to add testIsm
      warpDeployConfig[config.chainName].interchainSecurityModule = {
        type: IsmType.TEST_ISM,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read back the config and verify ISM was set
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(config.warpReadOutputPath);

      const ismConfig =
        updatedWarpDeployConfig[config.chainName].interchainSecurityModule;

      assert(ismConfig, 'ISM config should be defined');
      assert(
        typeof ismConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        ismConfig.type === IsmType.TEST_ISM,
        `Expected ISM type to be ${IsmType.TEST_ISM}, got ${ismConfig.type}`,
      );
      expect(ismConfig.address).to.be.a('string');
    });

    it('should update ISM from testIsm to messageIdMultisigIsm', async function () {
      if (config.skipTests?.updateTestIsmToMessageIdMultisigIsm) {
        this.skip();
        return;
      }

      // First set testIsm
      warpDeployConfig[config.chainName].interchainSecurityModule = {
        type: IsmType.TEST_ISM,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      const newIsmConfig: IsmConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: ['0x10E0271ec47d55511a047516f2a7301801d55eaB'].map(
          (address) => normalizeAddress(address),
        ),
        threshold: 1,
      };

      // Now update to messageIdMultisigIsm
      warpDeployConfig[config.chainName].interchainSecurityModule =
        newIsmConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read back and verify the new ISM type
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(config.warpReadOutputPath);

      const ismConfig =
        updatedWarpDeployConfig[config.chainName].interchainSecurityModule;

      assert(ismConfig, 'ISM config should be defined');
      assert(
        typeof ismConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        ismConfig.type === IsmType.MESSAGE_ID_MULTISIG,
        `Expected ISM type to be ${IsmType.MESSAGE_ID_MULTISIG}, got ${ismConfig.type}`,
      );
      expect(ismConfig.address).to.be.a('string');
      expect(
        ismConfig.validators.map((address) => normalizeAddress(address)),
      ).to.deep.equal(newIsmConfig.validators);
      expect(ismConfig.threshold).to.equal(newIsmConfig.threshold);
    });

    it('should update ISM from testIsm to nothing (unset)', async function () {
      if (config.skipTests?.updateTestIsmToDefaultIsm) {
        this.skip();
        return;
      }

      // First set testIsm
      warpDeployConfig[config.chainName].interchainSecurityModule = {
        type: IsmType.TEST_ISM,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Verify ISM was set
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      let updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(config.warpReadOutputPath);

      expect(updatedWarpDeployConfig[config.chainName].interchainSecurityModule)
        .to.not.be.undefined;

      // Now remove the ISM
      delete warpDeployConfig[config.chainName].interchainSecurityModule;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read back and verify ISM was unset
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      updatedWarpDeployConfig = readYamlOrJson(config.warpReadOutputPath);

      const ismConfig =
        updatedWarpDeployConfig[config.chainName].interchainSecurityModule;

      // ISM should be reset to zero address
      expect(ismConfig).to.equal('0x0000000000000000000000000000000000000000');
    });

    it('should update mutable routing ISM without redeployment', async function () {
      if (config.skipTests?.updateMutableRoutingIsm) {
        this.skip();
        return;
      }

      // First deploy with a routing ISM
      const initialRoutingIsmConfig: RoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner: warpDeployConfig[config.chainName].owner,
        domains: {
          [config.chainName]: {
            type: IsmType.TEST_ISM,
          },
        },
      };

      warpDeployConfig[config.chainName].interchainSecurityModule =
        initialRoutingIsmConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read the deployed config to get ISM address
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      let updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(config.warpReadOutputPath);

      const initialIsm =
        updatedWarpDeployConfig[config.chainName].interchainSecurityModule;

      assert(
        initialIsm && typeof initialIsm !== 'string',
        'Initial ISM should be defined',
      );
      assert(
        initialIsm.type === IsmType.ROUTING,
        'Initial ISM should be routing ISM',
      );
      assert(initialIsm.address, 'Initial ISM should have address');

      const initialIsmAddress = initialIsm.address;

      const domainIsm = initialIsm.domains[config.chainName];
      assert(
        domainIsm && typeof domainIsm !== 'string',
        'Domain ISM should be defined',
      );

      const initialDomainIsmAddress = (domainIsm as any).address;
      assert(initialDomainIsmAddress, 'Domain ISM should have address');

      // Now update only the owner (mutable property)
      const updatedRoutingIsmConfig: RoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner: config.alternateOwnerAddress,
        domains: {
          [config.chainName]: {
            type: IsmType.TEST_ISM,
          },
        },
      };

      warpDeployConfig[config.chainName].interchainSecurityModule =
        updatedRoutingIsmConfig;

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read back and verify:
      // 1. Routing ISM address stayed the same (updated in-place)
      // 2. Owner was updated
      // 3. Nested domain ISM address stayed the same (not redeployed)
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      updatedWarpDeployConfig = readYamlOrJson(config.warpReadOutputPath);

      const finalIsm =
        updatedWarpDeployConfig[config.chainName].interchainSecurityModule;

      assert(
        finalIsm && typeof finalIsm !== 'string',
        'Final ISM should be defined',
      );
      assert(
        finalIsm.type === IsmType.ROUTING,
        `Expected ISM type to be ${IsmType.ROUTING}, got ${finalIsm.type}`,
      );
      assert(finalIsm.address, 'Final ISM should have address');

      // Routing ISM should NOT be redeployed - same address
      expect(finalIsm.address).to.equal(initialIsmAddress);

      // Owner should be updated
      expect(normalizeAddress(finalIsm.owner)).to.equal(
        normalizeAddress(config.alternateOwnerAddress),
      );

      // Nested domain ISM should NOT be redeployed - same address
      const finalDomainIsm = finalIsm.domains[config.chainName];
      assert(
        finalDomainIsm && typeof finalDomainIsm !== 'string',
        'Final domain ISM should be defined',
      );
      assert(
        (finalDomainIsm as any).address,
        'Final domain ISM should have address',
      );

      expect((finalDomainIsm as any).address).to.equal(initialDomainIsmAddress);
      expect(finalDomainIsm.type).to.equal(IsmType.TEST_ISM);
    });

    it('should not redeploy ISM when applying same config twice (idempotency)', async function () {
      if (config.skipTests?.ismUpdateIdempotency) {
        this.skip();
        return;
      }

      // First deployment - set testIsm
      warpDeployConfig[config.chainName].interchainSecurityModule = {
        type: IsmType.TEST_ISM,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read to get ISM address
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const firstConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        config.warpReadOutputPath,
      );
      const firstIsmConfig =
        firstConfig[config.chainName].interchainSecurityModule;

      assert(firstIsmConfig, 'ISM config should be defined after first apply');
      assert(
        typeof firstIsmConfig !== 'string',
        'ISM should not be an address string',
      );
      const firstIsmAddress = firstIsmConfig.address;

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

      const secondConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        config.warpReadOutputPath,
      );
      const secondIsmConfig =
        secondConfig[config.chainName].interchainSecurityModule;

      assert(
        secondIsmConfig,
        'ISM config should be defined after second apply',
      );
      assert(
        typeof secondIsmConfig !== 'string',
        'ISM should not be an address string',
      );

      // ISM address should be identical (no redeployment)
      expect(secondIsmConfig.address).to.equal(firstIsmAddress);
      expect(secondIsmConfig.type).to.equal(IsmType.TEST_ISM);
    });

    it('should redeploy ISM when static config changes (multisig)', async function () {
      if (config.skipTests?.redeployIsmOnStaticConfigChange) {
        this.skip();
        return;
      }

      // Deploy multisig ISM with initial validators
      const initialValidators = [randomAddress()];
      warpDeployConfig[config.chainName].interchainSecurityModule = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: initialValidators,
        threshold: 1,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read to get first ISM address
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const firstConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        config.warpReadOutputPath,
      );
      const firstIsmConfig =
        firstConfig[config.chainName].interchainSecurityModule;

      assert(firstIsmConfig, 'ISM config should be defined');
      assert(
        typeof firstIsmConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        firstIsmConfig.type === IsmType.MESSAGE_ID_MULTISIG,
        `Expected ISM type to be ${IsmType.MESSAGE_ID_MULTISIG}, got ${firstIsmConfig.type}`,
      );
      const firstIsmAddress = firstIsmConfig.address;

      // Update multisig ISM config - change validators (static/immutable)
      const newValidators = ['0x1234567890123456789012345678901234567890'];
      warpDeployConfig[config.chainName].interchainSecurityModule = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: newValidators,
        threshold: 1,
      };

      writeYamlOrJson(config.warpDeployPath, warpDeployConfig);

      await warpCommands.applyRaw({
        warpRouteId: config.warpRouteId,
        hypKey: config.privateKey,
      });

      // Read and verify new ISM deployed
      await warpCommands.readRaw({
        warpRouteId: config.warpRouteId,
        outputPath: config.warpReadOutputPath,
      });

      const secondConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        config.warpReadOutputPath,
      );
      const secondIsmConfig =
        secondConfig[config.chainName].interchainSecurityModule;

      assert(secondIsmConfig, 'ISM config should be defined after update');
      assert(
        typeof secondIsmConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        secondIsmConfig.type === IsmType.MESSAGE_ID_MULTISIG,
        `Expected ISM type to be ${IsmType.MESSAGE_ID_MULTISIG}, got ${secondIsmConfig.type}`,
      );

      // ISM address should be different (new deployment)
      expect(secondIsmConfig.address).to.not.equal(firstIsmAddress);
      // Validators should be updated
      expect(
        secondIsmConfig.validators.map((address) => normalizeAddress(address)),
      ).to.deep.equal(
        newValidators.map((address) => normalizeAddress(address)),
      );
      expect(secondIsmConfig.threshold).to.equal(1);
    });
  });
}
