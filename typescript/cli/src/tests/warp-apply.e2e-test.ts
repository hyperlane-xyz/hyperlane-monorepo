import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  ANVIL_KEY,
  REGISTRY_PATH,
  deployOrUseExistingCore,
  extendWarpConfig,
  getChainId,
  updateOwner,
} from './commands/helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from './commands/warp.js';

/// To run: 1) start 2 anvils, 2) yarn run tsx tests/warp.zs-test.ts inside of cli/
const CHAIN_NAME_1 = 'anvil1';
const CHAIN_NAME_2 = 'anvil2';

const BURN_ADDRESS = '0x0000000000000000000000000000000000000001';
const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
const WARP_CONFIG_PATH = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
const WARP_CORE_CONFIG_PATH_1 = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil1-config.yaml`;

describe('WarpApply e2e tests', async function () {
  let chain2Addresses: ChainAddresses = {};
  this.timeout(0); // No limit timeout since these tests can take a while
  before(async function () {
    await deployOrUseExistingCore(CHAIN_NAME_1, CORE_CONFIG_PATH, ANVIL_KEY);
    chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_2,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );
  });

  after(async function () {
    this.timeout(2500);
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);
  });

  it('should burn owner address', async function () {
    const warpConfigPath = `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      BURN_ADDRESS,
      CHAIN_NAME_1,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_1,
    );
    const updatedWarpDeployConfig = await readWarpConfig(
      CHAIN_NAME_1,
      WARP_CORE_CONFIG_PATH_1,
      warpConfigPath,
    );
    expect(updatedWarpDeployConfig.anvil1.owner).to.equal(BURN_ADDRESS);
  });

  it('should not update the same owner', async () => {
    const warpConfigPath = `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      BURN_ADDRESS,
      CHAIN_NAME_1,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_1,
    );
    const { stdout } = await updateOwner(
      BURN_ADDRESS,
      CHAIN_NAME_1,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH_1,
    );

    expect(stdout).to.include(
      'Warp config on anvil1 is the same as target. No updates needed.',
    );
  });

  it('should extend an existing warp route', async () => {
    // Read existing config into a file
    const warpConfigPath = `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`;
    await readWarpConfig(CHAIN_NAME_1, WARP_CORE_CONFIG_PATH_1, warpConfigPath);

    // Extend with new config
    const config: TokenRouterConfig = {
      decimals: 18,
      mailbox: chain2Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      totalSupply: 0,
      type: TokenType.native,
    };

    await extendWarpConfig(
      CHAIN_NAME_1,
      CHAIN_NAME_2,
      config,
      WARP_CORE_CONFIG_PATH_1,
      warpConfigPath,
    );

    const COMBINED_WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil1-anvil2-config.yaml`;

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_1,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain2Id = await getChainId(CHAIN_NAME_2, ANVIL_KEY);
    const remoteRouterKeys1 = Object.keys(
      updatedWarpDeployConfig1[CHAIN_NAME_1].remoteRouters!,
    );
    expect(remoteRouterKeys1).to.include(chain2Id);

    // Check that chain1 is enrolled in chain2
    const updatedWarpDeployConfig2 = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );

    const chain1Id = await getChainId(CHAIN_NAME_1, ANVIL_KEY);
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[CHAIN_NAME_2].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain1Id);
  });
});
