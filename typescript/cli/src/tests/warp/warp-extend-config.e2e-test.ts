import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  DerivedTokenRouterConfig,
  TokenType,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  deployOrUseExistingCore,
  extendWarpConfig,
  getDomainId,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';

describe('hyperlane warp apply config extension tests', async function () {
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

  it('should update destination gas configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // Extend with new config
    const config: DerivedTokenRouterConfig = {
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
      warpDeployPath,
    });

    // First read the existing config
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

    // Get the domain ID for chain 3
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

    // Update with new destination gas values
    warpDeployConfig[CHAIN_NAME_2].destinationGas = {
      [chain3Id]: '500000', // Set a specific gas value for chain 3
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

    // Verify the destination gas was updated correctly
    expect(updatedConfig[CHAIN_NAME_2].destinationGas![chain3Id]).to.equal(
      '500000',
    );
  });

  it('should update remote routers configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // Extend with new config
    const config: DerivedTokenRouterConfig = {
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
      warpDeployPath,
    });

    // First read the existing config
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

    // Get the domain ID for chain 3
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

    // Generate a new router address to update
    const newRouterAddress = randomAddress();

    // Update with new remote router values
    warpDeployConfig[CHAIN_NAME_2].remoteRouters = {
      [chain3Id]: { address: newRouterAddress }, // Set a new router address for chain 3
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

    // Verify the remote router was updated correctly
    expect(
      updatedConfig[CHAIN_NAME_2].remoteRouters![
        chain3Id
      ].address.toLowerCase(),
    ).to.equal(newRouterAddress.toLowerCase());
  });

  it('should preserve deploy config when extending warp route', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

    // Extend with new config for chain 3
    const extendedConfig: DerivedTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    warpDeployConfig[CHAIN_NAME_3] = extendedConfig;
    // Remove remoteRouters and destinationGas as they are written in readWarpConfig
    delete warpDeployConfig[CHAIN_NAME_2].remoteRouters;
    delete warpDeployConfig[CHAIN_NAME_2].destinationGas;
    await writeYamlOrJson(warpDeployPath, warpDeployConfig);
    await hyperlaneWarpApply(warpDeployPath, WARP_CORE_CONFIG_PATH_2);

    const updatedConfig: WarpRouteDeployConfig = readYamlOrJson(warpDeployPath);

    expect(normalizeConfig(warpDeployConfig)).to.deep.equal(
      normalizeConfig(updatedConfig),
      'warp deploy config should remain unchanged after extension',
    );
  });
});
