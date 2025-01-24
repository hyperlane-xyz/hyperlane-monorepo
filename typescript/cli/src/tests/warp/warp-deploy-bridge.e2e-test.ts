import { JsonRpcProvider } from '@ethersproject/providers';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';
import { parseUnits } from 'ethers/lib/utils.js';

import { ERC20Test, ERC4626Test } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  Token,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  WARP_DEPLOY_OUTPUT_PATH,
  deploy4626Vault,
  deployOrUseExistingCore,
  deployToken,
  getCombinedWarpRoutePath,
  sendWarpRouteMessageRoundTrip,
} from '../commands/helpers.js';
import { generateWarpConfigs, hyperlaneWarpDeploy } from '../commands/warp.js';

chai.use(chaiAsPromised);
chai.should();

describe('hyperlane warp deploy and bridge e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let walletChain3: Wallet;

  let tokenChain2: ERC20Test;
  let tokenChain2Symbol: string;
  let vaultChain2: ERC4626Test;
  let tokenVaultChain2Symbol: string;

  let tokenChain3: ERC20Test;
  let tokenChain3Symbol: string;
  let vaultChain3: ERC4626Test;
  let tokenVaultChain3Symbol: string;

  let warpConfigTestCases: ReadonlyArray<WarpRouteDeployConfig>;

  before(async function () {
    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    const providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    const providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);

    ownerAddress = walletChain2.address;

    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    vaultChain2 = await deploy4626Vault(
      ANVIL_KEY,
      CHAIN_NAME_2,
      tokenChain2.address,
    );

    [tokenChain2Symbol, tokenVaultChain2Symbol] = await Promise.all([
      tokenChain2.symbol(),
      vaultChain2.symbol(),
    ]);

    tokenChain3 = await deployToken(ANVIL_KEY, CHAIN_NAME_3);
    vaultChain3 = await deploy4626Vault(
      ANVIL_KEY,
      CHAIN_NAME_3,
      tokenChain3.address,
    );

    [tokenChain3Symbol, tokenVaultChain3Symbol] = await Promise.all([
      tokenChain3.symbol(),
      vaultChain3.symbol(),
    ]);

    warpConfigTestCases = generateWarpConfigs(
      {
        chainName: CHAIN_NAME_2,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
        token: tokenChain2.address,
        vault: vaultChain2.address,
      },
      {
        chainName: CHAIN_NAME_3,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
        token: tokenChain3.address,
        vault: vaultChain3.address,
      },
    );
  });

  function getTokenSymbolFromDeployment(
    warpConfig: WarpRouteDeployConfig,
  ): string {
    let symbol: string;
    if (warpConfig[CHAIN_NAME_2].type.match(/.*vault.*/i)) {
      symbol = tokenVaultChain2Symbol;
    } else if (warpConfig[CHAIN_NAME_2].type.match(/.*collateral.*/i)) {
      symbol = tokenChain2Symbol;
    } else if (warpConfig[CHAIN_NAME_3].type.match(/.*vault.*/i)) {
      symbol = tokenVaultChain3Symbol;
    } else if (warpConfig[CHAIN_NAME_3].type.match(/.*collateral.*/i)) {
      symbol = tokenChain3Symbol;
    } else {
      symbol = 'ETH';
    }

    return symbol;
  }

  async function collateralizeWarpTokens(
    routeConfigPath: string,
    warpDeployConfig: WarpRouteDeployConfig,
    walletAndCollateralByChain: ChainMap<{
      wallet: Wallet;
      collateral: ERC20Test;
    }>,
  ) {
    const config: ChainMap<Token> = (
      readYamlOrJson(routeConfigPath) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    await Promise.all(
      [CHAIN_NAME_2, CHAIN_NAME_3]
        .filter((chainName) => walletAndCollateralByChain[chainName])
        .map(async (chainName) => {
          if (warpDeployConfig[chainName].type.match(/.*native/i)) {
            const tx = await walletAndCollateralByChain[
              chainName
            ].wallet.sendTransaction({
              to: config[chainName].addressOrDenom,
              value: 1_000_000_000,
            });

            await tx.wait();
          }

          if (
            !warpDeployConfig[chainName].type.match(/.*synthetic/i) &&
            warpDeployConfig[chainName].type.match(/.*collateral/i)
          ) {
            const decimals = await walletAndCollateralByChain[
              chainName
            ].collateral.decimals();
            const tx = await walletAndCollateralByChain[
              chainName
            ].collateral.transfer(
              config[chainName].addressOrDenom,
              parseUnits('1', decimals),
            );

            await tx.wait();
          }
        }),
    );
  }

  it('Should deploy and bridge different types of warp routes:', async function () {
    // Timeout increased only for this test because it runs multiple times with different deployment configs
    this.timeout(warpConfigTestCases.length * DEFAULT_E2E_TEST_TIMEOUT);

    for (const warpConfig of warpConfigTestCases) {
      console.log(
        `Should deploy and be able to bridge in a ${warpConfig[CHAIN_NAME_2].type} -> ${warpConfig[CHAIN_NAME_3].type} warp route ...`,
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

      const symbol = getTokenSymbolFromDeployment(warpConfig);

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
