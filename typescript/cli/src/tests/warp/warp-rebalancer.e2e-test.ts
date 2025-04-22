import { Wallet } from 'ethers';

import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import { TokenType, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  deployOrUseExistingCore,
  deployToken,
  getCombinedWarpRoutePath,
} from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpRebalancer,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';

describe('hyperlane warp rebalancer e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  describe('hyperlane warp rebalancer', () => {
    it('should successfully start and stop the warp rebalancer', async function () {
      // Deploy core contracts on all chains
      const chain2Addresses = await deployOrUseExistingCore(
        CHAIN_NAME_2,
        CORE_CONFIG_PATH,
        ANVIL_KEY,
      );
      const chain3Addresses = await deployOrUseExistingCore(
        CHAIN_NAME_3,
        CORE_CONFIG_PATH,
        ANVIL_KEY,
      );
      const chain4Addresses = await deployOrUseExistingCore(
        CHAIN_NAME_4,
        CORE_CONFIG_PATH,
        ANVIL_KEY,
      );

      // Deploy ERC20s
      const tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
      const tokenChain3 = await deployToken(ANVIL_KEY, CHAIN_NAME_3);
      const tokenSymbol = await tokenChain2.symbol();

      // Deploy Warp Route
      const warpDeploymentPath = getCombinedWarpRoutePath(tokenSymbol, [
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        CHAIN_NAME_4,
      ]);
      const ownerAddress = new Wallet(ANVIL_KEY).address;
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: tokenChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.collateral,
          token: tokenChain3.address,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
        [CHAIN_NAME_4]: {
          type: TokenType.synthetic,
          mailbox: chain4Addresses.mailbox,
          owner: ownerAddress,
        },
      };
      writeYamlOrJson(warpDeploymentPath, warpConfig);
      await hyperlaneWarpDeploy(warpDeploymentPath);

      // Bridge tokens from the collateral chains to the synthetic
      await hyperlaneWarpSendRelay(
        CHAIN_NAME_2,
        CHAIN_NAME_4,
        warpDeploymentPath,
        true,
        toWei(49),
      );
      await hyperlaneWarpSendRelay(
        CHAIN_NAME_3,
        CHAIN_NAME_4,
        warpDeploymentPath,
        true,
        toWei(51),
      );

      // Start the rebalancer
      const warpRouteId = createWarpRouteConfigId(tokenSymbol.toUpperCase(), [
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        CHAIN_NAME_4,
      ]);
      const process = hyperlaneWarpRebalancer(warpRouteId, 1000);

      // Verify that it logs an expected output
      for await (const chunk of process.stdout) {
        if (
          chunk.includes(`Executing rebalancing routes: [
  {
    fromChain: 'anvil3',
    toChain: 'anvil2',
    amount: 1000000000000000000n
  }
]`)
        ) {
          process.kill();
          break;
        }
      }
    });
  });
});
