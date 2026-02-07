import { expect } from 'chai';
import { Wallet } from 'ethers';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type HypTokenRouterConfig,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { getDomainId } from '../commands/helpers.js';
import {
  extendWarpConfig,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  WARP_CONFIG_PATH_EXAMPLE,
  getCombinedWarpRoutePath,
} from '../consts.js';

/**
 * Tests for extending multi-chain warp routes.
 *
 * These tests verify that when extending a warp route that already spans
 * multiple chains (e.g., chain2 + chain3), all existing chains are preserved
 * in the deploy config, not just one.
 *
 * Bug context: The extendWarpConfig helper previously only read config for
 * a single chain, causing other existing chains to be missing from the
 * deploy config when extending multi-chain routes.
 */
describe('hyperlane warp apply multi-chain extension tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let chain4Addresses: ChainAddresses = {};

  const WARP_CONFIG_PATH_MULTICHAIN = `${TEMP_PATH}/warp-route-deployment-multichain.yaml`;
  const WARP_DEPLOY_MULTICHAIN_ID = 'ETH/anvil2-anvil3';

  before(async function () {
    // Deploy core contracts to all three chains
    [chain2Addresses, chain3Addresses, chain4Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
  });

  beforeEach(async function () {
    // Create a warp config spanning TWO chains (chain2 + chain3)
    const warpConfigExample: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    const multiChainConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        ...warpConfigExample.anvil1,
        mailbox: chain2Addresses.mailbox,
        owner: new Wallet(ANVIL_KEY).address,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: new Wallet(ANVIL_KEY).address,
      },
    };

    writeYamlOrJson(WARP_CONFIG_PATH_MULTICHAIN, multiChainConfig);

    // Deploy the initial 2-chain warp route
    await hyperlaneWarpDeploy(
      WARP_CONFIG_PATH_MULTICHAIN,
      WARP_DEPLOY_MULTICHAIN_ID,
    );
  });

  it('should extend a multi-chain warp route (2 chains -> 3 chains) and preserve all existing chains', async () => {
    // Get the warp core config path for the 2-chain route
    const WARP_CORE_CONFIG_PATH_2_CHAINS = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-multichain-extend.yaml`;

    // Verify initial state: 2 chains exist
    const initialWarpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH_2_CHAINS,
    );
    expect(initialWarpCoreConfig.tokens).to.have.lengthOf(2);
    expect(
      initialWarpCoreConfig.tokens.map((t) => t.chainName).sort(),
    ).to.deep.equal([CHAIN_NAME_2, CHAIN_NAME_3].sort());

    // Create config for the new chain (chain4)
    const chain4Config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain4Addresses.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      type: TokenType.synthetic,
    };

    // Extend the 2-chain route to 3 chains
    await extendWarpConfig({
      chainToExtend: CHAIN_NAME_4,
      extendedConfig: chain4Config,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_CHAINS,
      warpDeployPath,
    });

    // Get the new warp core config path for the 3-chain route
    const WARP_CORE_CONFIG_PATH_3_CHAINS = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);

    // Verify the resulting config has all 3 chains
    const resultWarpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH_3_CHAINS,
    );
    expect(resultWarpCoreConfig.tokens).to.have.lengthOf(3);
    expect(
      resultWarpCoreConfig.tokens.map((t) => t.chainName).sort(),
    ).to.deep.equal([CHAIN_NAME_2, CHAIN_NAME_3, CHAIN_NAME_4].sort());

    // Get domain IDs for verification
    const chain2Id = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
    const chain3Id = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);
    const chain4Id = await getDomainId(CHAIN_NAME_4, ANVIL_KEY);

    // Verify chain2 has routers enrolled for chain3 AND chain4
    const chain2Config = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_3_CHAINS,
      warpDeployPath,
    );
    const chain2RemoteRouters = Object.keys(
      chain2Config[CHAIN_NAME_2].remoteRouters!,
    );
    expect(chain2RemoteRouters).to.include(
      chain3Id,
      'chain2 should have chain3 enrolled',
    );
    expect(chain2RemoteRouters).to.include(
      chain4Id,
      'chain2 should have chain4 enrolled',
    );

    // Verify chain3 has routers enrolled for chain2 AND chain4
    const chain3Config = await readWarpConfig(
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_3_CHAINS,
      warpDeployPath,
    );
    const chain3RemoteRouters = Object.keys(
      chain3Config[CHAIN_NAME_3].remoteRouters!,
    );
    expect(chain3RemoteRouters).to.include(
      chain2Id,
      'chain3 should have chain2 enrolled',
    );
    expect(chain3RemoteRouters).to.include(
      chain4Id,
      'chain3 should have chain4 enrolled',
    );

    // Verify chain4 has routers enrolled for chain2 AND chain3
    const chain4ConfigResult = await readWarpConfig(
      CHAIN_NAME_4,
      WARP_CORE_CONFIG_PATH_3_CHAINS,
      warpDeployPath,
    );
    const chain4RemoteRouters = Object.keys(
      chain4ConfigResult[CHAIN_NAME_4].remoteRouters!,
    );
    expect(chain4RemoteRouters).to.include(
      chain2Id,
      'chain4 should have chain2 enrolled',
    );
    expect(chain4RemoteRouters).to.include(
      chain3Id,
      'chain4 should have chain3 enrolled',
    );
  });
});
