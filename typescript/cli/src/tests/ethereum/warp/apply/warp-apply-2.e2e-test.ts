import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HypTokenRouterConfig,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../../../../utils/files.js';
import { deployOrUseExistingCore } from '../../commands/core.js';
import {
  exportWarpConfigsToFilePaths,
  getDeployedWarpAddress,
} from '../../commands/helpers.js';
import {
  hyperlaneWarpApplyRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../../commands/warp.js';
import {
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
} from '../../consts.js';

describe('hyperlane warp apply owner update tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);
  let chain3Addresses: ChainAddresses = {};

  before(async function () {
    await deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY);

    chain3Addresses = await deployOrUseExistingCore(
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
      mailbox: chain3Addresses!.mailbox,
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

  //   it('should update the remote gas and routers configuration when specified using the domain name', async () => {
  //     const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

  //     // First read the existing config
  //     const warpDeployConfig = await readWarpConfig(
  //       TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  //       WARP_CORE_CONFIG_PATH_2,
  //       warpDeployPath,
  //     );

  //     const expectedRemoteGasSetting = '30000';
  //     warpDeployConfig[
  //       TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
  //     ].destinationGas = {
  //       [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]:
  //         expectedRemoteGasSetting,
  //     };

  //     const expectedRemoteRouter = randomAddress();
  //     warpDeployConfig[
  //       TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
  //     ].remoteRouters = {
  //       [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
  //         address: expectedRemoteRouter,
  //       },
  //     };

  //     // Write the updated config
  //     await writeYamlOrJson(warpDeployPath, warpDeployConfig);

  //     await hyperlaneWarpApply(warpDeployPath, WARP_CORE_CONFIG_PATH_2);
  //     const updatedConfig = await readWarpConfig(
  //       TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  //       WARP_CORE_CONFIG_PATH_2,
  //       warpDeployPath,
  //     );

  //     expect(
  //       (updatedConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
  //         .destinationGas ?? {})[chain3Metadata.domainId],
  //     ).to.deep.equal(expectedRemoteGasSetting);
  //     expect(
  //       normalizeAddressEvm(
  //         (updatedConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
  //           .remoteRouters ?? {})[chain3Metadata.domainId].address,
  //       ),
  //     ).to.deep.equal(addressToBytes32(expectedRemoteRouter));
  //   });
});
