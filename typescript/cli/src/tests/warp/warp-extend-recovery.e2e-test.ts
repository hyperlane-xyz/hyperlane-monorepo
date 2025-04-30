import { expect } from 'chai';
import { Wallet } from 'ethers';

import { TokenRouter__factory } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import { getContext } from '../../context/context.js';
import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
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
import { hyperlaneWarpDeploy, readWarpConfig } from '../commands/warp.js';

describe('hyperlane warp apply recovery extension tests', async function () {
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

  it('should recover and re-enroll routers after direct contract-level unenrollment through TokenRouter interface', async () => {
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

  it('should set correct gas values when completing warp route extension', async () => {
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
});
