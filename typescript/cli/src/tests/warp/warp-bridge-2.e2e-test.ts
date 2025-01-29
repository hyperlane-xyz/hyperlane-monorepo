import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';

import { ERC20Test, ERC4626Test } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
  sendWarpRouteMessageRoundTrip,
} from '../commands/helpers.js';
import { hyperlaneWarpDeploy } from '../commands/warp.js';

import {
  collateralizeWarpTokens,
  generateTestCases,
  getTokenSymbolFromDeployment,
  setupChains,
} from './warp-bridge-utils.js';

chai.use(chaiAsPromised);
chai.should();

describe('hyperlane warp deploy and bridge e2e tests - Part 2', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses,
    chain3Addresses: ChainAddresses,
    ownerAddress: Address,
    walletChain2: Wallet,
    walletChain3: Wallet;
  let tokenChain2: ERC20Test,
    tokenChain2Symbol: string,
    vaultChain2: ERC4626Test,
    tokenVaultChain2Symbol: string;
  let tokenChain3: ERC20Test,
    tokenChain3Symbol: string,
    vaultChain3: ERC4626Test,
    tokenVaultChain3Symbol: string;
  let warpConfigTestCases: ReadonlyArray<WarpRouteDeployConfig>;

  before(async function () {
    ({
      chain2Addresses,
      chain3Addresses,
      ownerAddress,
      walletChain2,
      walletChain3,
      tokenChain2,
      tokenChain2Symbol,
      vaultChain2,
      tokenVaultChain2Symbol,
      tokenChain3,
      tokenChain3Symbol,
      vaultChain3,
      tokenVaultChain3Symbol,
    } = await setupChains());

    warpConfigTestCases = generateTestCases(
      chain2Addresses,
      chain3Addresses,
      ownerAddress,
      tokenChain2,
      vaultChain2,
      tokenChain3,
      vaultChain3,
      2,
      1,
    );
  });

  it('Should deploy and bridge different types of warp routes - Part 2:', async function () {
    this.timeout(warpConfigTestCases.length * DEFAULT_E2E_TEST_TIMEOUT);

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
  });
});
