import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HookType,
  HypTokenRouterConfig,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  E2E_TEST_BURN_ADDRESS,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  WARP_DEPLOY_2_ID,
  deployOrUseExistingCore,
  exportWarpConfigsToFilePaths,
  getDeployedWarpAddress,
  updateOwner,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';

describe('hyperlane warp apply owner update tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);
  let chain2Addresses: ChainAddresses = {};
  before(async function () {
    await deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY);

    chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_3,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );

    // Create a new warp config using the example
    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2, WARP_DEPLOY_2_ID);
  });

  it('should burn owner address', async function () {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      E2E_TEST_BURN_ADDRESS,
      CHAIN_NAME_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
    );
    const updatedWarpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );
    expect(updatedWarpDeployConfig.anvil2.owner).to.equal(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should not update the same owner', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      E2E_TEST_BURN_ADDRESS,
      CHAIN_NAME_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
    );
    const { stdout } = await updateOwner(
      E2E_TEST_BURN_ADDRESS,
      CHAIN_NAME_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
    );
    expect(stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  it('should update the owner of both the warp token and the proxy admin', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    // Set to undefined if it was defined in the config
    warpConfig.anvil1.proxyAdmin = undefined;
    warpConfig.anvil1.owner = E2E_TEST_BURN_ADDRESS;
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(warpConfigPath, anvil2Config);

    await hyperlaneWarpApply(
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
      undefined,
      WARP_DEPLOY_2_ID,
    );

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(E2E_TEST_BURN_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should update only the owner of the warp token if the proxy admin config is specified', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    // Explicitly set it to the deployer address if it was not defined
    warpConfig.anvil1.proxyAdmin = { owner: ANVIL_DEPLOYER_ADDRESS };
    warpConfig.anvil1.owner = E2E_TEST_BURN_ADDRESS;
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(warpConfigPath, anvil2Config);

    await hyperlaneWarpApply(
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
      undefined,
      WARP_CORE_CONFIG_PATH_2,
    );

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(E2E_TEST_BURN_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      ANVIL_DEPLOYER_ADDRESS,
    );
  });

  it('should update only the owner of the proxy admin if the proxy admin config is specified', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    warpConfig.anvil1.proxyAdmin = { owner: E2E_TEST_BURN_ADDRESS };
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(warpConfigPath, anvil2Config);

    await hyperlaneWarpApply(
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
      undefined,
      WARP_CORE_CONFIG_PATH_2,
    );

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(ANVIL_DEPLOYER_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should update hook configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // First read the existing config
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

    // Update with a new hook config
    const owner = randomAddress();
    warpDeployConfig[CHAIN_NAME_2].hook = {
      type: HookType.PROTOCOL_FEE,
      beneficiary: owner,
      maxProtocolFee: '1000000',
      protocolFee: '100000',
      owner,
    };

    // Write the updated config
    await writeYamlOrJson(warpDeployPath, warpDeployConfig);

    // Apply the changes
    await hyperlaneWarpApply(
      warpDeployPath,
      WARP_CORE_CONFIG_PATH_2,
      undefined,
      WARP_CORE_CONFIG_PATH_2,
    );

    // Read back the config to verify changes
    const updatedConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

    // Verify the hook was updated with all properties
    expect(normalizeConfig(updatedConfig[CHAIN_NAME_2].hook)).to.deep.equal(
      normalizeConfig(warpDeployConfig[CHAIN_NAME_2].hook),
    );
  });

  it('should extend a warp route with a custom warp route id', async () => {
    // Read existing config
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );

    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    warpConfig.anvil3 = config;

    // Copy over the warp deploy AND core to custom warp route id filepath
    // This simulates the user updating the warp route id in the registry
    const warpRouteId = 'ETH/custom-warp-route-id-2';
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH_2,
    );
    const { warpCorePath: updatedWarpCorePath } = exportWarpConfigsToFilePaths({
      warpRouteId,
      warpConfig,
      warpCoreConfig,
    });

    // Apply
    await hyperlaneWarpApplyRaw({
      warpRouteId,
    });

    // getDeployedWarpAddress() throws if address does not exist
    const extendAddress = getDeployedWarpAddress(
      CHAIN_NAME_3,
      updatedWarpCorePath,
    );
    expect(extendAddress).to.be.exist;
    expect(extendAddress).to.not.equal(ethers.constants.AddressZero);
  });

  it('should apply changes to a warp route with a custom warp route id', async () => {
    // Read existing config
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );

    // Update the existing warp route config
    warpConfig.anvil2.owner = E2E_TEST_BURN_ADDRESS;

    // Copy over the warp deploy AND core to custom warp route id filepath
    // This simulates the user updating the warp route id in the registry
    const warpRouteId = 'ETH/custom-warp-route-id-2';
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH_2,
    );
    const {
      warpDeployPath: updatedWarpDeployPath,
      warpCorePath: updatedWarpCorePath,
    } = exportWarpConfigsToFilePaths({
      warpRouteId,
      warpCoreConfig,
      warpConfig,
    });

    // Apply
    await hyperlaneWarpApplyRaw({
      warpRouteId,
    });

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      updatedWarpCorePath,
      updatedWarpDeployPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(E2E_TEST_BURN_ADDRESS);
  });
});
