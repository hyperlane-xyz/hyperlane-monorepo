import { expect } from 'chai';

import { type IsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type DerivedWarpRouteDeployConfig,
  IsmType,
  type RoutingIsmConfig,
  TokenType,
  type WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, normalizeAddress } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';

describe('hyperlane warp apply ISM updates (Radix E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const nativeTokenData =
    TEST_CHAIN_METADATA_BY_PROTOCOL.radix.CHAIN_NAME_1.nativeToken;
  assert(
    nativeTokenData,
    `Expected native token data to be defined for chain ${TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1}`,
  );
  const nativeTokenAddress = nativeTokenData.denom;
  assert(
    nativeTokenAddress,
    `Expected native token address to be defined for ${TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1}`,
  );

  let chain1CoreAddress: ChainAddresses;
  const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Radix,
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.radix,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
  );

  const WARP_CORE_PATH = getWarpCoreConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Radix,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  before(async function () {
    chain1CoreAddress = await hyperlaneCore1.deployOrUseExistingCore(
      HYP_KEY_BY_PROTOCOL.radix,
    );
  });

  let warpDeployConfig: WarpRouteDeployConfig;

  describe('ISM updates', () => {
    beforeEach(async () => {
      // Deploy warp route without ISM initially
      warpDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]: {
          type: TokenType.collateral,
          token: nativeTokenAddress,
          mailbox: chain1CoreAddress.mailbox,
          owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
          name: nativeTokenData.name,
          symbol: nativeTokenData.symbol,
          decimals: nativeTokenData.decimals,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
      await hyperlaneWarp.deployRaw({
        warpRouteId: WARP_ROUTE_ID,
        skipConfirmationPrompts: true,
        privateKey: HYP_KEY_BY_PROTOCOL.radix,
      });
    });

    it('should update ISM from nothing to testIsm', async function () {
      // Update config to add testIsm
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = {
        type: IsmType.TEST_ISM,
      };

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read back the config and verify ISM was set
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(WARP_READ_OUTPUT_PATH);

      const ismConfig =
        updatedWarpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

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

    it('should update ISM from testIsm to merkleRootMultisigIsm', async function () {
      // First set testIsm
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = {
        type: IsmType.TEST_ISM,
      };

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      const newIsmConfig: IsmConfig = {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        validators: ['0x10E0271ec47d55511a047516f2a7301801d55eaB'].map(
          (address) => normalizeAddress(address),
        ),
        threshold: 1,
      };

      // Now update to merkleRootMultisigIsm
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = newIsmConfig;

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read back and verify the new ISM type
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(WARP_READ_OUTPUT_PATH);

      const ismConfig =
        updatedWarpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

      assert(ismConfig, 'ISM config should be defined');
      assert(
        typeof ismConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        ismConfig.type === IsmType.MERKLE_ROOT_MULTISIG,
        `Expected ISM type to be ${IsmType.MERKLE_ROOT_MULTISIG}, got ${ismConfig.type}`,
      );
      expect(ismConfig.address).to.be.a('string');
      expect(
        ismConfig.validators.map((address) => normalizeAddress(address)),
      ).to.deep.equal(newIsmConfig.validators);
      expect(ismConfig.threshold).to.equal(ismConfig.threshold);
    });

    it('should update ISM from testIsm to nothing (unset)', async function () {
      // First set testIsm
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = {
        type: IsmType.TEST_ISM,
      };

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Verify ISM was set
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      let updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(WARP_READ_OUTPUT_PATH);

      expect(
        updatedWarpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule,
      ).to.not.be.undefined;

      // Now remove the ISM
      delete warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
        .interchainSecurityModule;

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read back and verify ISM was unset
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      updatedWarpDeployConfig = readYamlOrJson(WARP_READ_OUTPUT_PATH);

      const ismConfig =
        updatedWarpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

      // ISM should be the default mailbox ISM address (not undefined)
      // On Radix, unsetting an ISM reverts to the default mailbox ISM
      expect(ismConfig).to.be.a('string');
    });

    it('should not redeploy ISM when applying same config twice (idempotency)', async function () {
      // First deployment - set testIsm
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = {
        type: IsmType.TEST_ISM,
      };

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read to get ISM address
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const firstConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      );
      const firstIsmConfig =
        firstConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

      assert(firstIsmConfig, 'ISM config should be defined after first apply');
      assert(
        typeof firstIsmConfig !== 'string',
        'ISM should not be an address string',
      );
      const firstIsmAddress = firstIsmConfig.address;

      // Apply same config again
      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read again and verify address unchanged
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const secondConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      );
      const secondIsmConfig =
        secondConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

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

    it('should update mutable routing ISM without redeployment', async function () {
      // Deploy routing ISM with one domain
      const routingIsmConfig: RoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        domains: {
          [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]: {
            type: IsmType.TEST_ISM,
          },
        },
      };

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = routingIsmConfig;

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read to get routing ISM address
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const firstConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      );
      const firstIsmConfig =
        firstConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

      assert(firstIsmConfig, 'ISM config should be defined');
      assert(
        typeof firstIsmConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        firstIsmConfig.type === IsmType.ROUTING,
        `Expected ISM type to be ${IsmType.ROUTING}, got ${firstIsmConfig.type}`,
      );
      const routingIsmAddress = firstIsmConfig.address;
      const expectedDomainIsm =
        firstIsmConfig.domains[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1];
      assert(typeof expectedDomainIsm !== 'string', '');
      const expectedDomainIsmAddress = (expectedDomainIsm as any).address;

      // Update routing ISM - change owner (mutable property)
      const newOwner = BURN_ADDRESS_BY_PROTOCOL.radix;
      const updatedRoutingIsmConfig: RoutingIsmConfig = {
        ...routingIsmConfig,
        owner: newOwner,
      };

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = updatedRoutingIsmConfig;

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read and verify address unchanged but owner updated
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const secondConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      );
      const secondIsmConfig =
        secondConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

      assert(secondIsmConfig, 'ISM config should be defined after update');
      assert(
        typeof secondIsmConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        secondIsmConfig.type === IsmType.ROUTING,
        `Expected ISM type to be ${IsmType.ROUTING}, got ${secondIsmConfig.type}`,
      );
      const currentDomainIsm =
        secondIsmConfig.domains[
          TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
        ];
      assert(typeof currentDomainIsm !== 'string', '');
      const currentDomainIsmAddress = (currentDomainIsm as any).address;

      // Routing ISM address should be unchanged (mutable update)
      expect(secondIsmConfig.address).to.equal(routingIsmAddress);
      // Owner should be updated
      expect(normalizeAddress(secondIsmConfig.owner)).to.equal(
        normalizeAddress(newOwner),
      );

      expect(normalizeAddress(currentDomainIsmAddress)).to.equal(
        normalizeAddress(expectedDomainIsmAddress),
      );
    });

    it('should redeploy ISM when static config changes (multisig)', async function () {
      // Deploy multisig ISM with initial validators (EVM addresses even on Radix)
      const initialValidators = [randomAddress()];
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        validators: initialValidators,
        threshold: 1,
      };

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read to get first ISM address
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const firstConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      );
      const firstIsmConfig =
        firstConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

      assert(firstIsmConfig, 'ISM config should be defined');
      assert(
        typeof firstIsmConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        firstIsmConfig.type === IsmType.MERKLE_ROOT_MULTISIG,
        `Expected ISM type to be ${IsmType.MERKLE_ROOT_MULTISIG}, got ${firstIsmConfig.type}`,
      );
      const firstIsmAddress = firstIsmConfig.address;

      // Update multisig ISM config - change validators (static/immutable)
      // Validators are always EVM addresses regardless of blockchain
      const newValidators = ['0x1234567890123456789012345678901234567890'];
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1
      ].interchainSecurityModule = {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        validators: newValidators,
        threshold: 1,
      };

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      // Read and verify new ISM deployed
      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const secondConfig: DerivedWarpRouteDeployConfig = readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      );
      const secondIsmConfig =
        secondConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .interchainSecurityModule;

      assert(secondIsmConfig, 'ISM config should be defined after update');
      assert(
        typeof secondIsmConfig !== 'string',
        'ISM should not be an address string',
      );
      assert(
        secondIsmConfig.type === IsmType.MERKLE_ROOT_MULTISIG,
        `Expected ISM type to be ${IsmType.MERKLE_ROOT_MULTISIG}, got ${secondIsmConfig.type}`,
      );

      // ISM address should be different (new deployment)
      expect(secondIsmConfig.address).to.not.equal(firstIsmAddress);
      // Validators should be updated to new EVM addresses
      expect(
        secondIsmConfig.validators.map((address) => normalizeAddress(address)),
      ).to.deep.equal(
        newValidators.map((address) => normalizeAddress(address)),
      );
      expect(secondIsmConfig.threshold).to.equal(1);
    });
  });
});
