import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
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
  CHAIN_2_METADATA_PATH,
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
  exportWarpConfigsToFilePaths,
  getCombinedWarpRoutePath,
  getDeployedWarpAddress,
  getDomainId,
  resetAnvilFork,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';

/**
 * Test Flow Overview:
 * - These tests run against local Anvil forks that are reset to a clean snapshot
 *   with only a warp route and the core protocol functionality deployed.
 * - The reset logic is in the beforeEach each hook which will:
 *    - reset the global warpConfig variable to the initial state
 *    - reset the config files in the test registry
 *    - reset the anvil fork to the initial state after the before hook runs
 *
 * Adding Your Own Tests:
 * - The warpConfig can be modified as needed as it will be reset to the expected initial state
 *   after the test runs
 * - Before calling warp apply use `writeYamlOrJson(...)` to persist any deploy config
 *   changes and be sure to supply the correct path to the command to read the deploy config.
 * - If a test that was working starts to fail, probably an incorrect deploy config is being
 *   used either because the path is wrong or the original config is not being reset in memory
 *   or on disk when read from the registry. Be sure to add any new path that might be used in
 *   new test to the reset logic to avoid test failing because of a previous test run
 */
describe('hyperlane warp apply e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain3Addresses: ChainAddresses = {};
  let chain2Metadata: ChainMetadata;
  let warpConfig: WarpRouteDeployConfig;
  let chain2Provider: JsonRpcProvider;
  let deployAnvilStateId: string;

  const warpDeployConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

  function resetWarpConfig() {
    const rawWarpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    warpConfig = {
      [CHAIN_NAME_2]: { ...rawWarpConfig.anvil1 },
    };

    writeYamlOrJson(WARP_CONFIG_PATH_2, warpConfig);
  }

  before(async function () {
    chain2Metadata = readYamlOrJson(CHAIN_2_METADATA_PATH);

    [, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    resetWarpConfig();
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2);

    chain2Provider = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    deployAnvilStateId = await chain2Provider.send('evm_snapshot', []);
  });

  // Reset config before each test to avoid test changes intertwining
  beforeEach(async function () {
    resetWarpConfig();

    deployAnvilStateId = await resetAnvilFork(
      chain2Provider,
      deployAnvilStateId,
    );
  });

  it('should burn owner address', async function () {
    warpConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;
    writeYamlOrJson(warpDeployConfigPath, warpConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const updatedWarpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );
    expect(updatedWarpDeployConfig.anvil2.owner).to.equal(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should not update the same owner', async () => {
    warpConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;
    writeYamlOrJson(warpDeployConfigPath, warpConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const { stdout } = await hyperlaneWarpApply(
      warpDeployConfigPath,
      WARP_CORE_CONFIG_PATH_2,
    );
    expect(stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  it('should update the owner of both the warp token and the proxy admin', async () => {
    // Set to undefined if it was defined in the config
    warpConfig[CHAIN_NAME_2].proxyAdmin = undefined;
    warpConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;
    writeYamlOrJson(warpDeployConfigPath, warpConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(E2E_TEST_BURN_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should update only the owner of the warp token if the proxy admin config is specified', async () => {
    // Explicitly set it to the deployer address if it was not defined
    warpConfig[CHAIN_NAME_2].proxyAdmin = { owner: ANVIL_DEPLOYER_ADDRESS };
    warpConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;
    writeYamlOrJson(warpDeployConfigPath, warpConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(E2E_TEST_BURN_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      ANVIL_DEPLOYER_ADDRESS,
    );
  });

  it('should update only the owner of the proxy admin if the proxy admin config is specified', async () => {
    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    warpConfig.anvil1.proxyAdmin = { owner: E2E_TEST_BURN_ADDRESS };
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(warpDeployConfigPath, anvil2Config);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(ANVIL_DEPLOYER_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should update hook configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // Update with a new hook config
    const owner = randomAddress();
    warpConfig[CHAIN_NAME_2].hook = {
      type: HookType.PROTOCOL_FEE,
      beneficiary: owner,
      maxProtocolFee: '1000000',
      protocolFee: '100000',
      owner,
    };

    // Write the updated config
    await writeYamlOrJson(warpDeployPath, warpConfig);

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
      normalizeConfig(warpConfig[CHAIN_NAME_2].hook),
    );
  });

  it('should extend an existing warp route', async () => {
    // Read existing config into a file
    const originalWarpConfig: WarpRouteDeployConfig =
      readYamlOrJson(WARP_CONFIG_PATH_2);
    await writeYamlOrJson(warpDeployConfigPath, originalWarpConfig);

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
    writeYamlOrJson(warpDeployConfigPath, warpConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpDeployConfigPath,
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
      warpDeployConfigPath,
    );

    const chain1Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[CHAIN_NAME_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain1Id);
  });

  it('should extend a warp route with a custom warp route id', async () => {
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
