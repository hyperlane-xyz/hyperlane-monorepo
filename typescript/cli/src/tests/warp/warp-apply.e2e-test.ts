import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HookType,
  HypTokenRouterConfig,
  TokenType,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { assert, normalizeAddressEvm } from '@hyperlane-xyz/utils';

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
  deployOrUseExistingCore,
  extendWarpConfig,
  getCombinedWarpRoutePath,
  getDomainId,
  updateOwner,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
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
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2);
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

    await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH_2);

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

    await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH_2);

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

    await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH_2);

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
    await hyperlaneWarpApply(warpDeployPath, WARP_CORE_CONFIG_PATH_2);

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

  it('should extend an existing warp route', async () => {
    // Read existing config into a file
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await readWarpConfig(CHAIN_NAME_2, WARP_CORE_CONFIG_PATH_2, warpConfigPath);

    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: config,
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: warpConfigPath,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain2Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);
    const remoteRouterKeys1 = Object.keys(
      updatedWarpDeployConfig1[CHAIN_NAME_2].remoteRouters!,
    );
    expect(remoteRouterKeys1).to.include(chain2Id);

    // Check that chain1 is enrolled in chain2
    const updatedWarpDeployConfig2 = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain1Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[CHAIN_NAME_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain1Id);
  });

  it('should add a new rebalancer and remove an existing one', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    // Add the first address as rebalancer and then remove it and add the second one
    const allowedRebalancers = [randomAddress(), randomAddress()].map(
      normalizeAddressEvm,
    );

    for (const rebalancer of allowedRebalancers) {
      const anvil2Config = {
        anvil2: { ...warpConfig.anvil1, allowedRebalancers: [rebalancer] },
      };
      writeYamlOrJson(warpConfigPath, anvil2Config);

      await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH_2);

      const updatedWarpDeployConfig = await readWarpConfig(
        CHAIN_NAME_2,
        WARP_CORE_CONFIG_PATH_2,
        warpConfigPath,
      );

      assert(
        updatedWarpDeployConfig.anvil2.type === TokenType.collateral,
        `Config on chain ${CHAIN_NAME_2} must be a collateral`,
      );
      expect(
        updatedWarpDeployConfig.anvil2.allowedRebalancers?.length,
      ).to.equal(1);

      const [currentRebalancer] =
        updatedWarpDeployConfig.anvil2.allowedRebalancers ?? [];
      expect(currentRebalancer).to.equal(rebalancer);
    }
  });
});
