import { expect } from 'chai';
import { Wallet } from 'ethers';

import { TokenRouter__factory } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HypTokenRouterConfig,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';

import { getContext } from '../../context/context.js';
import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  E2E_TEST_BURN_ADDRESS,
  EXAMPLES_PATH,
  REGISTRY_PATH,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  deployOrUseExistingCore,
  extendWarpConfig,
  getCombinedWarpRoutePath,
  getDomainId,
  setupIncompleteWarpRouteExtension,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';

describe('hyperlane warp apply warp route extension tests', async function () {
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

  it('should extend an existing warp route with json strategy', async () => {
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
      strategyUrl: `${EXAMPLES_PATH}/submit/strategy/json-rpc-chain-strategy.yaml`,
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

  it('should extend an existing warp route and update the owner', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    // Burn anvil2 owner in config
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );
    warpDeployConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;

    // Extend with new config
    const randomOwner = new Wallet(ANVIL_KEY).address;
    const extendedConfig: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: randomOwner,
      symbol: 'ETH',
      type: TokenType.native,
    };
    // Remove remoteRouters and destinationGas as they are written in readWarpConfig
    warpDeployConfig[CHAIN_NAME_2].remoteRouters = undefined;
    warpDeployConfig[CHAIN_NAME_2].destinationGas = undefined;

    warpDeployConfig[CHAIN_NAME_3] = extendedConfig;
    writeYamlOrJson(warpDeployPath, warpDeployConfig);
    await hyperlaneWarpApply(warpDeployPath, WARP_CORE_CONFIG_PATH_2);

    const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    const updatedWarpDeployConfig_2 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpDeployPath,
    );
    const updatedWarpDeployConfig_3 = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpDeployPath,
    );
    // Check that anvil2 owner is burned
    expect(updatedWarpDeployConfig_2.anvil2.owner).to.equal(
      E2E_TEST_BURN_ADDRESS,
    );

    // Also, anvil3 owner is not burned
    expect(updatedWarpDeployConfig_3.anvil3.owner).to.equal(randomOwner);

    // Check that both chains enrolled
    const chain2Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig_2[CHAIN_NAME_2].remoteRouters!,
    );
    const remoteRouterKeys3 = Object.keys(
      updatedWarpDeployConfig_3[CHAIN_NAME_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain3Id);
    expect(remoteRouterKeys3).to.include(chain2Id);
  });

  it('should extend an existing warp route and update all destination domains', async () => {
    // Read existing config into a file
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );
    warpDeployConfig[CHAIN_NAME_2].gas = 7777;

    // Extend with new config
    const GAS = 694200;
    const extendedConfig: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      type: TokenType.native,
      gas: GAS,
    };

    // Remove remoteRouters and destinationGas as they are written in readWarpConfig
    warpDeployConfig[CHAIN_NAME_2].remoteRouters = undefined;
    warpDeployConfig[CHAIN_NAME_2].destinationGas = undefined;

    warpDeployConfig[CHAIN_NAME_3] = extendedConfig;
    writeYamlOrJson(warpConfigPath, warpDeployConfig);
    await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH_2);

    const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig_2 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain2Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

    // Destination gas should be set in the existing chain (chain2) to include the extended chain (chain3)
    const destinationGas_2 =
      updatedWarpDeployConfig_2[CHAIN_NAME_2].destinationGas!;
    expect(Object.keys(destinationGas_2)).to.include(chain3Id);
    expect(destinationGas_2[chain3Id]).to.equal(GAS.toString());

    // Destination gas should be set for the extended chain (chain3)
    const updatedWarpDeployConfig_3 = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    const destinationGas_3 =
      updatedWarpDeployConfig_3[CHAIN_NAME_3].destinationGas!;
    expect(Object.keys(destinationGas_3)).to.include(chain2Id);
    expect(destinationGas_3[chain2Id]).to.equal('7777');
  });

  it('should recover and re-enroll routers after direct contract-level unenrollment through TokenRouter interface (without having to specify the router table manually)', async () => {
    const { multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });

    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // Initial setup with chain3 using extendWarpConfig
    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: {
        decimals: 18,
        mailbox: chain2Addresses!.mailbox,
        name: 'Ether',
        owner: new Wallet(ANVIL_KEY).address,
        symbol: 'ETH',
        type: TokenType.native,
      },
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: warpConfigPath,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    const warpCoreConfig = readYamlOrJson(
      COMBINED_WARP_CORE_CONFIG_PATH,
    ) as WarpCoreConfig;
    const deployedTokenRoute = warpCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_2,
    )?.addressOrDenom;

    if (!deployedTokenRoute) {
      throw new Error('Failed to find deployed token route address');
    }

    // Manually call unenrollRemoteRouters
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);
    const tokenRouter = TokenRouter__factory.connect(
      deployedTokenRoute,
      new Wallet(ANVIL_KEY).connect(multiProvider.getProvider(CHAIN_NAME_2)),
    );
    await tokenRouter.unenrollRemoteRouters([chain3Id]);

    // Verify the router was unenrolled
    const beforeRecoveryConfig = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    expect(
      Object.keys(beforeRecoveryConfig[CHAIN_NAME_2].remoteRouters || {}),
    ).to.not.include(chain3Id.toString());

    // Re-extend to fix the configuration
    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: {
        decimals: 18,
        mailbox: chain2Addresses!.mailbox,
        name: 'Ether',
        owner: new Wallet(ANVIL_KEY).address,
        symbol: 'ETH',
        type: TokenType.native,
      },
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: warpConfigPath,
    });

    const recoveredConfig = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    expect(
      Object.keys(recoveredConfig[CHAIN_NAME_2].remoteRouters!),
    ).to.include(chain3Id.toString());
  });

  it('should complete warp route extension when previous attempt left incomplete enrollment or destination gas settings (second attempt on new combined config)', async () => {
    const {
      chain2DomainId,
      chain3DomainId,
      warpConfigPath,
      configToExtend,
      combinedWarpCorePath,
    } = await setupIncompleteWarpRouteExtension(chain2Addresses);

    // Verify initial state - neither chain should be enrolled in the other
    const initialConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath,
      warpConfigPath,
    );
    const initialConfig3 = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath,
      warpConfigPath,
    );
    // Check remote routers initial state
    expect(
      Object.keys(initialConfig2[CHAIN_NAME_2].remoteRouters!),
    ).to.not.include(chain3DomainId);
    expect(
      Object.keys(initialConfig3[CHAIN_NAME_3].remoteRouters!),
    ).to.not.include(chain2DomainId);

    // Check destination gas initial state
    expect(
      Object.keys(initialConfig2[CHAIN_NAME_2].destinationGas || {}),
    ).to.not.include(chain3DomainId);
    expect(
      Object.keys(initialConfig3[CHAIN_NAME_3].destinationGas || {}),
    ).to.not.include(chain2DomainId);

    // Complete the extension
    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: configToExtend,
      warpCorePath: combinedWarpCorePath,
      warpDeployPath: warpConfigPath,
    });

    // Verify both chains are now properly configured
    const finalConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath,
      warpConfigPath,
    );
    const finalConfig3 = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath,
      warpConfigPath,
    );

    // Check remote routers final state
    expect(Object.keys(finalConfig2[CHAIN_NAME_2].remoteRouters!)).to.include(
      chain3DomainId,
    );
    expect(Object.keys(finalConfig3[CHAIN_NAME_3].remoteRouters!)).to.include(
      chain2DomainId,
    );

    // Check destination gas final state
    expect(Object.keys(finalConfig2[CHAIN_NAME_2].destinationGas!)).to.include(
      chain3DomainId,
    );
    expect(Object.keys(finalConfig3[CHAIN_NAME_3].destinationGas!)).to.include(
      chain2DomainId,
    );
  });

  it('should complete warp route extension when previous attempt left incomplete enrollment or destination gas settings (second attempt with same config)', async () => {
    const {
      chain2DomainId,
      chain3DomainId,
      warpConfigPath,
      configToExtend,
      combinedWarpCorePath,
    } = await setupIncompleteWarpRouteExtension(chain2Addresses);

    // Verify initial state - neither chain should be enrolled in the other
    const initialConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath,
      warpConfigPath,
    );
    const initialConfig3 = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath,
      warpConfigPath,
    );
    // Check remote routers initial state
    expect(
      Object.keys(initialConfig2[CHAIN_NAME_2].remoteRouters!),
    ).to.not.include(chain3DomainId);
    expect(
      Object.keys(initialConfig3[CHAIN_NAME_3].remoteRouters!),
    ).to.not.include(chain2DomainId);

    // Check destination gas initial state
    expect(
      Object.keys(initialConfig2[CHAIN_NAME_2].destinationGas || {}),
    ).to.not.include(chain3DomainId);
    expect(
      Object.keys(initialConfig3[CHAIN_NAME_3].destinationGas || {}),
    ).to.not.include(chain2DomainId);

    // Complete the extension
    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: configToExtend,
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: combinedWarpCorePath,
    });

    // Verify both chains are now properly configured
    const finalConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath,
      warpConfigPath,
    );
    const finalConfig3 = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath,
      warpConfigPath,
    );

    // Check remote routers final state
    expect(Object.keys(finalConfig2[CHAIN_NAME_2].remoteRouters!)).to.include(
      chain3DomainId,
    );
    expect(Object.keys(finalConfig3[CHAIN_NAME_3].remoteRouters!)).to.include(
      chain2DomainId,
    );

    // Check destination gas final state
    expect(Object.keys(finalConfig2[CHAIN_NAME_2].destinationGas!)).to.include(
      chain3DomainId,
    );
    expect(Object.keys(finalConfig3[CHAIN_NAME_3].destinationGas!)).to.include(
      chain2DomainId,
    );
  });

  it('should set correct gas values when completing warp route extension (without having to specify the gas table manually)', async () => {
    const {
      chain2DomainId,
      chain3DomainId,
      warpConfigPath,
      configToExtend,
      combinedWarpCorePath,
    } = await setupIncompleteWarpRouteExtension(chain2Addresses);

    // Verify initial state - gas values should not be set
    const initialConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath,
      warpConfigPath,
    );
    const initialConfig3 = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath,
      warpConfigPath,
    );

    // Check initial gas values
    expect(initialConfig2[CHAIN_NAME_2].destinationGas?.[chain3DomainId]).to.be
      .undefined;
    expect(initialConfig3[CHAIN_NAME_3].destinationGas?.[chain2DomainId]).to.be
      .undefined;

    // Set specific gas values for the extension
    const customGasValue = '300000';
    configToExtend.gas = parseInt(customGasValue);

    // Complete the extension with custom gas value
    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: configToExtend,
      warpCorePath: combinedWarpCorePath,
      warpDeployPath: warpConfigPath,
    });

    // Verify gas values are correctly set after extension
    const finalConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      combinedWarpCorePath,
      warpConfigPath,
    );
    const finalConfig3 = await readWarpConfig(
      CHAIN_NAME_3,
      combinedWarpCorePath,
      warpConfigPath,
    );

    // Check gas value is set correctly
    expect(finalConfig2[CHAIN_NAME_2].destinationGas![chain3DomainId]).to.equal(
      customGasValue,
    );

    // Verify remote routers are also properly set
    expect(Object.keys(finalConfig2[CHAIN_NAME_2].remoteRouters!)).to.include(
      chain3DomainId,
    );
    expect(Object.keys(finalConfig3[CHAIN_NAME_3].remoteRouters!)).to.include(
      chain2DomainId,
    );
  });

  it('should update destination gas configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

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
    const extendedConfig: HypTokenRouterConfig = {
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
