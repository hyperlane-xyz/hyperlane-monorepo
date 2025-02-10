import { expect } from 'chai';
import { Wallet } from 'ethers';

import { TokenRouter__factory } from '@hyperlane-xyz/core';
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

import { getContext } from '../../context/context.js';
import { extendWarpRoute as extendWarpRouteWithoutApplyTransactions } from '../../deploy/warp.js';
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
  updateOwner,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';

describe('hyperlane warp apply e2e tests', async function () {
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
      totalSupply: 0,
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
      totalSupply: 0,
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
      totalSupply: 0,
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
      totalSupply: 0,
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

  it('should recover and re-enroll routers after direct contract-level unenrollment through TokenRouter interface', async () => {
    const { multiProvider } = await getContext({
      registryUri: REGISTRY_PATH,
      registryOverrideUri: '',
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
        totalSupply: 0,
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
        totalSupply: 0,
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

  it.only('should complete warp route extension when previous attempt left incomplete enrollment or destination gas settings', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const configToExtend: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };
    const context = await getContext({
      registryUri: REGISTRY_PATH,
      registryOverrideUri: '',
      key: ANVIL_KEY,
    });
    const warpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH_2,
    ) as WarpCoreConfig;
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );

    warpDeployConfig[CHAIN_NAME_3] = configToExtend;

    const signer2 = new Wallet(
      ANVIL_KEY,
      context.multiProvider.getProvider(CHAIN_NAME_2),
    );
    const signer3 = new Wallet(
      ANVIL_KEY,
      context.multiProvider.getProvider(CHAIN_NAME_3),
    );
    context.multiProvider.setSigner(CHAIN_NAME_2, signer2);
    context.multiProvider.setSigner(CHAIN_NAME_3, signer3);

    await extendWarpRouteWithoutApplyTransactions(
      {
        context: {
          ...context,
          signer: signer3,
          key: ANVIL_KEY,
        },
        warpCoreConfig,
        warpDeployConfig,
        receiptsDir: TEMP_PATH,
      },
      {},
      Object.fromEntries(
        warpCoreConfig.tokens.map((token) => [token.chainName, token]),
      ),
    );

    const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

    expect(
      Object.keys(updatedWarpDeployConfig1[CHAIN_NAME_2].remoteRouters!),
    ).to.not.include(chain3Id);

    await extendWarpConfig({
      chain: CHAIN_NAME_2,
      chainToExtend: CHAIN_NAME_3,
      extendedConfig: configToExtend,
      warpCorePath: COMBINED_WARP_CORE_CONFIG_PATH,
      warpDeployPath: warpConfigPath,
    });

    const updatedWarpDeployConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    expect(
      Object.keys(updatedWarpDeployConfig2[CHAIN_NAME_2].remoteRouters!),
    ).to.include(chain3Id);
  });
});
