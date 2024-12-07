import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  TokenRouterConfig,
  TokenType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  ZKSYNC_KEY,
  deployOrUseExistingCore,
  extendWarpConfig,
  getDomainId,
  updateOwner,
} from './commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from './commands/warp.js';

const CHAIN_NAME_ZK_2 = 'zksync1';
const CHAIN_NAME_ZK_3 = 'zksync2';

export const TEST_CONFIGS_PATH = './test-configs';
export const ZK_REGISTRY_PATH = `${TEST_CONFIGS_PATH}/zksync`;

const BURN_ADDRESS = '0x0000000000000000000000000000000000000001';
const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config-zksync.yaml`;
const WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;

const TEMP_PATH = '/tmp'; //temp gets removed at the end of all-test.sh
const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/zksync/warp-route-deployment.yaml`;
const WARP_CORE_CONFIG_PATH_2 = `${ZK_REGISTRY_PATH}/deployments/warp_routes/ETH/${CHAIN_NAME_ZK_2}-config.yaml`;

const TEST_TIMEOUT = 180_000; // Long timeout since these tests can take a while
describe.skip('WarpApply zkSync e2e tests', async function () {
  let chain2Addresses: ChainAddresses = {};
  this.timeout(TEST_TIMEOUT);

  before(async function () {
    await deployOrUseExistingCore(
      CHAIN_NAME_ZK_2,
      CORE_CONFIG_PATH,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_ZK_3,
      CORE_CONFIG_PATH,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    // Create a new warp config using the example
    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    const zksync2Config = {
      zksync1: { ...warpConfig.anvil1 },
    };

    writeYamlOrJson(WARP_CONFIG_PATH_2, zksync2Config);
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2, ZKSYNC_KEY, ZK_REGISTRY_PATH);
  });

  it('should burn owner address', async function () {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      BURN_ADDRESS,
      CHAIN_NAME_ZK_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    const updatedWarpDeployConfig = await readWarpConfig(
      CHAIN_NAME_ZK_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    expect(updatedWarpDeployConfig.zksync1.owner).to.equal(BURN_ADDRESS);
  });

  it('should not update the same owner', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      BURN_ADDRESS,
      CHAIN_NAME_ZK_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    const { stdout } = await updateOwner(
      BURN_ADDRESS,
      CHAIN_NAME_ZK_2,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_2,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    expect(stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  it('should extend an existing warp route', async () => {
    // Read existing config into a file
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-zksync-2.yaml`;
    await readWarpConfig(
      CHAIN_NAME_ZK_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    // Extend with new config
    const config: TokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ZKSYNC_KEY).address,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };

    await extendWarpConfig({
      chain: CHAIN_NAME_ZK_2,
      chainToExtend: CHAIN_NAME_ZK_3,
      extendedConfig: config,
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: warpConfigPath,
      key: ZKSYNC_KEY,
      registryPath: ZK_REGISTRY_PATH,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = `${ZK_REGISTRY_PATH}/deployments/warp_routes/ETH/${CHAIN_NAME_ZK_2}-${CHAIN_NAME_ZK_3}-config.yaml`;

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_ZK_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    const chain2Id = await getDomainId(
      CHAIN_NAME_ZK_3,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    const remoteRouterKeys1 = Object.keys(
      updatedWarpDeployConfig1[CHAIN_NAME_ZK_2].remoteRouters!,
    );
    expect(remoteRouterKeys1).to.include(chain2Id);

    // Check that chain1 is enrolled in chain2
    const updatedWarpDeployConfig2 = await readWarpConfig(
      CHAIN_NAME_ZK_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[CHAIN_NAME_ZK_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(
      await getDomainId(CHAIN_NAME_ZK_2, ZKSYNC_KEY, ZK_REGISTRY_PATH),
    );
  });

  it('should extend an existing warp route with json strategy', async () => {
    // Read existing config into a file
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    await readWarpConfig(
      CHAIN_NAME_ZK_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    // Extend with new config
    const config: TokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ZKSYNC_KEY).address,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };

    await extendWarpConfig({
      chain: CHAIN_NAME_ZK_2,
      chainToExtend: CHAIN_NAME_ZK_3,
      extendedConfig: config,
      warpCorePath: WARP_CORE_CONFIG_PATH_2,
      warpDeployPath: warpConfigPath,
      strategyUrl: `${EXAMPLES_PATH}/submit/strategy/json-rpc-chain-strategy.yaml`,
      key: ZKSYNC_KEY,
      registryPath: ZK_REGISTRY_PATH,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = `${ZK_REGISTRY_PATH}/deployments/warp_routes/ETH/${CHAIN_NAME_ZK_2}-${CHAIN_NAME_ZK_3}-config.yaml`;

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_ZK_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    const chain2Id = await getDomainId(
      CHAIN_NAME_ZK_3,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    const remoteRouterKeys1 = Object.keys(
      updatedWarpDeployConfig1[CHAIN_NAME_ZK_2].remoteRouters!,
    );
    expect(remoteRouterKeys1).to.include(chain2Id);

    // Check that chain1 is enrolled in chain2
    const updatedWarpDeployConfig2 = await readWarpConfig(
      CHAIN_NAME_ZK_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    const chain1Id = await getDomainId(
      CHAIN_NAME_ZK_2,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[CHAIN_NAME_ZK_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain1Id);
  });

  it('should extend an existing warp route and update the owner', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    // Burn zksync1 owner in config
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_ZK_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    warpDeployConfig[CHAIN_NAME_ZK_2].owner = BURN_ADDRESS;

    // Extend with new config
    const randomOwner = new Wallet(ZKSYNC_KEY).address;
    const extendedConfig: TokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: randomOwner,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };

    warpDeployConfig[CHAIN_NAME_ZK_3] = extendedConfig;
    writeYamlOrJson(warpDeployPath, warpDeployConfig);
    await hyperlaneWarpApply(
      warpDeployPath,
      WARP_CORE_CONFIG_PATH_2,
      undefined,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    const COMBINED_WARP_CORE_CONFIG_PATH = `${ZK_REGISTRY_PATH}/deployments/warp_routes/ETH/${CHAIN_NAME_ZK_2}-${CHAIN_NAME_ZK_3}-config.yaml`;

    const updatedWarpDeployConfig_2 = await readWarpConfig(
      CHAIN_NAME_ZK_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpDeployPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    const updatedWarpDeployConfig_3 = await readWarpConfig(
      CHAIN_NAME_ZK_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpDeployPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    // Check that zksync2 owner is burned
    expect(updatedWarpDeployConfig_2.zksync1.owner).to.equal(BURN_ADDRESS);

    expect(updatedWarpDeployConfig_3.zksync2.owner).to.equal(randomOwner);

    // Check that both chains enrolled
    const chain2Id = await getDomainId(
      CHAIN_NAME_ZK_2,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    const chain3Id = await getDomainId(
      CHAIN_NAME_ZK_3,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig_2[CHAIN_NAME_ZK_2].remoteRouters!,
    );
    const remoteRouterKeys3 = Object.keys(
      updatedWarpDeployConfig_3[CHAIN_NAME_ZK_3].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain3Id);
    expect(remoteRouterKeys3).to.include(chain2Id);
  });
});
