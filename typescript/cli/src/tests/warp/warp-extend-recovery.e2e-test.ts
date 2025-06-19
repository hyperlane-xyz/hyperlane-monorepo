import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Wallet } from 'ethers';

import { TokenRouter__factory } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  CORE_PROTOCOL_ANVIL_STATE,
  ChainMetadata,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import { getContext } from '../../context/context.js';
import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  WARP_DEPLOY_2_ID,
  WARP_DEPLOY_OUTPUT_PATH,
  extendWarpConfig,
  getCombinedWarpRoutePath,
  getDomainId,
  resetAnvilForksBatch,
  setupIncompleteWarpRouteExtension,
} from '../commands/helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from '../commands/warp.js';

describe('hyperlane warp apply recovery extension tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain3Addresses: ChainAddresses = {};
  let combinedWarpCoreConfigPath: string;

  let warpDeployConfig: WarpRouteDeployConfig;
  // it will be replaced at the first deployment
  let warpCoreConfig: WarpCoreConfig = { tokens: [] };
  let deployedAnvilStateIdChain2: string;
  let deployedAnvilStateIdChain3: string;

  let chain2Provider: JsonRpcProvider;
  let chain3Provider: JsonRpcProvider;

  function resetWarpConfig() {
    const rawWarpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    warpDeployConfig = {
      [CHAIN_NAME_2]: { ...rawWarpConfig.anvil1 },
    };

    writeYamlOrJson(WARP_CONFIG_PATH_2, warpDeployConfig);
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
    writeYamlOrJson(combinedWarpCoreConfigPath, warpCoreConfig);
    writeYamlOrJson(
      combinedWarpCoreConfigPath.replace('-config.yaml', '-deploy.yaml'),
      warpDeployConfig,
    );
  }

  before(async function () {
    chain3Addresses = CORE_PROTOCOL_ANVIL_STATE.addresses;

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    chain2Provider = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    chain3Provider = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

    combinedWarpCoreConfigPath = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
    ]);

    resetWarpConfig();
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2, WARP_DEPLOY_2_ID);
    warpCoreConfig = readYamlOrJson(combinedWarpCoreConfigPath);

    deployedAnvilStateIdChain2 = await chain2Provider.send('evm_snapshot', []);
    deployedAnvilStateIdChain3 = await chain3Provider.send('evm_snapshot', []);
  });

  // Reset config before each test to avoid test changes intertwining
  // Reset config before each test to avoid test changes intertwining
  beforeEach(async function () {
    resetWarpConfig();

    [deployedAnvilStateIdChain2, deployedAnvilStateIdChain3] =
      await resetAnvilForksBatch([
        [chain2Provider, deployedAnvilStateIdChain2],
        [chain3Provider, deployedAnvilStateIdChain3],
      ]);
  });

  it.only('should recover and re-enroll routers after direct contract-level unenrollment through TokenRouter interface', async () => {
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
        mailbox: chain3Addresses!.mailbox,
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
        mailbox: chain3Addresses!.mailbox,
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
    } = await setupIncompleteWarpRouteExtension(chain3Addresses);

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
    } = await setupIncompleteWarpRouteExtension(chain3Addresses);

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
    } = await setupIncompleteWarpRouteExtension(chain3Addresses);

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
