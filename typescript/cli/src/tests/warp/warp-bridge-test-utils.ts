import { Wallet } from 'ethers';

import { ERC20Test } from '@hyperlane-xyz/core';
import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
  sendWarpRouteMessageRoundTrip,
} from '../commands/helpers.js';
import { hyperlaneWarpDeploy } from '../commands/warp.js';

import {
  collateralizeWarpTokens,
  getTokenSymbolFromDeployment,
} from './warp-bridge-utils.js';

export async function runWarpBridgeTests(
  warpConfigTestCases: ReadonlyArray<WarpRouteDeployConfig>,
  tokenVaultChain2Symbol: string,
  tokenChain2Symbol: string,
  tokenVaultChain3Symbol: string,
  tokenChain3Symbol: string,
  walletChain2: Wallet,
  walletChain3: Wallet,
  tokenChain2: ERC20Test,
  tokenChain3: ERC20Test,
) {
  for (let i = 0; i < warpConfigTestCases.length; i++) {
    const warpConfig = warpConfigTestCases[i];
    console.log(
      `[${i + 1} of ${
        warpConfigTestCases.length
      }] Should deploy and be able to bridge in a ${
        warpConfig[CHAIN_NAME_2].type
      } -> ${warpConfig[CHAIN_NAME_3].type} warp route ...`,
    );

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    let startChain, targetChain: string;
    if (!warpConfig[CHAIN_NAME_2].type.match(/.*synthetic.*/i)) {
      startChain = CHAIN_NAME_2;
      targetChain = CHAIN_NAME_3;
    } else {
      startChain = CHAIN_NAME_3;
      targetChain = CHAIN_NAME_2;
    }

    const symbol = getTokenSymbolFromDeployment(
      warpConfig,
      tokenVaultChain2Symbol,
      tokenChain2Symbol,
      tokenVaultChain3Symbol,
      tokenChain3Symbol,
    );

    const routeConfigPath = getCombinedWarpRoutePath(symbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    await collateralizeWarpTokens(routeConfigPath, warpConfig, {
      [CHAIN_NAME_2]: {
        wallet: walletChain2,
        collateral: tokenChain2,
      },
      [CHAIN_NAME_3]: {
        wallet: walletChain3,
        collateral: tokenChain3,
      },
    });

    await sendWarpRouteMessageRoundTrip(
      startChain,
      targetChain,
      routeConfigPath,
    );

    console.log(
      `Should deploy and be able to bridge in a ${warpConfig[CHAIN_NAME_2].type} -> ${warpConfig[CHAIN_NAME_3].type} warp route ✅`,
    );
  }
}
