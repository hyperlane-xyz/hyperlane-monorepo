import { expect } from 'chai';
import { Wallet } from 'ethers';
import { beforeEach } from 'mocha';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { getRegistry } from '../context/context.js';

import {
  ANVIL_KEY,
  REGISTRY_PATH,
  deployOrUseExistingCore,
  extendWarpConfig,
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
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil1-config.yaml`;

describe('WarpApply', async function () {
  this.timeout(0); // No limit timeout since these tests can take a while

  //@ts-ignore
  let chain1Addresses: ChainAddresses = {};
  let chain2Addresses: ChainAddresses = {};
  before(async () => {
    chain1Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_1,
      CORE_CONFIG_PATH,
    );
    chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_2,
      CORE_CONFIG_PATH,
    );
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);
  });

  it('should burn owner address', async function () {
    const warpConfigPath = `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      CHAIN_NAME_1,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH,
      BURN_ADDRESS,
    );
    const updatedWarpDeployConfig = await readWarpConfig(
      CHAIN_NAME_1,
      WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    expect(updatedWarpDeployConfig.anvil1.owner).to.equal(BURN_ADDRESS);
  });

  it('should not update the same owner', async () => {
    const warpConfigPath = `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`;
    await updateOwner(
      CHAIN_NAME_1,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH,
      BURN_ADDRESS,
    );
    const { stdout } = await updateOwner(
      CHAIN_NAME_1,
      warpConfigPath,
      WARP_CORE_CONFIG_PATH,
      BURN_ADDRESS,
    );

    expect(stdout).to.include(
      'Warp config on anvil1 is the same as target. No updates needed.',
    );
  });

  it.only('should extend an existing warp route', async () => {
    // Read existing config into a file
    const warpConfigPath = `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`;
    await readWarpConfig(CHAIN_NAME_1, WARP_CORE_CONFIG_PATH, warpConfigPath);

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
      WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    const updatedWarpDeployConfig = await readWarpConfig(
      CHAIN_NAME_1,
      WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    const chainMetadata = await getRegistry(REGISTRY_PATH, '').getChainMetadata(
      CHAIN_NAME_2,
    );
    const chain2Id = String(chainMetadata?.chainId);
    const remoteRouterKeys = Object.keys(
      updatedWarpDeployConfig[CHAIN_NAME_1].remoteRouters!,
    );
    expect(remoteRouterKeys).to.include(chain2Id);
    console.log(updatedWarpDeployConfig);
  });
});
