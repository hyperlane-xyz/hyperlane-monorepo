import { JsonRpcProvider } from '@ethersproject/providers';
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
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../../constants.js';
import { deploy4626Vault, deployToken } from '../commands/helpers.js';
import { generateWarpConfigs } from '../commands/warp.js';

export const TOTAL_PARTS = 2;

export type WarpBridgeTestConfig = {
  chain2Addresses: ChainAddresses;
  chain3Addresses: ChainAddresses;
  ownerAddress: Address;
  tokenVaultChain2Symbol: string;
  tokenChain2Symbol: string;
  tokenVaultChain3Symbol: string;
  tokenChain3Symbol: string;
  walletChain2: Wallet;
  walletChain3: Wallet;
  tokenChain2: ERC20Test;
  vaultChain2: ERC4626Test;
  tokenChain3: ERC20Test;
  vaultChain3: ERC4626Test;
};

export async function runWarpBridgeTests(
  config: WarpBridgeTestConfig,
  warpConfigTestCases: ReadonlyArray<WarpRouteDeployConfig>,
) {
  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  for (let i = 0; i < warpConfigTestCases.length; i++) {
    const warpConfig = warpConfigTestCases[i];
    console.log(
      `[${i + 1} of ${
        warpConfigTestCases.length
      }] Should deploy and be able to bridge in a ${
        warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type
      } -> ${warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].type} warp route ...`,
    );

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    const symbol = getTokenSymbolFromDeployment(
      warpConfig,
      config.tokenVaultChain2Symbol,
      config.tokenChain2Symbol,
      config.tokenVaultChain3Symbol,
      config.tokenChain3Symbol,
    );
    const warpRouteId = `${symbol}/hyperlane`;
    const routeConfigPath = `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}-config.yaml`;

    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      warpRouteId,
    );

    let startChain, targetChain: string;
    if (
      !warpConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].type.match(/.*synthetic.*/i)
    ) {
      startChain = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
      targetChain = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3;
    } else {
      startChain = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3;
      targetChain = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    }

    await collateralizeWarpTokens(routeConfigPath, warpConfig, {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        wallet: config.walletChain2,
        collateral: config.tokenChain2,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        wallet: config.walletChain3,
        collateral: config.tokenChain3,
      },
    });

    await evmWarpCommands.sendAndRelay({
      origin: startChain,
      destination: targetChain,
      warpCorePath: routeConfigPath,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    await evmWarpCommands.sendAndRelay({
      origin: targetChain,
      destination: startChain,
      warpCorePath: routeConfigPath,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    console.log(
      `Should deploy and be able to bridge in a ${warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type} -> ${warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].type} warp route ✅`,
    );
  }
}

export async function setupChains(): Promise<WarpBridgeTestConfig> {
  const chain2Metadata: ChainMetadata =
    TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
  const chain3Metadata: ChainMetadata =
    TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3;

  const providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
  const providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

  const walletChain2 = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).connect(
    providerChain2,
  );
  const walletChain3 = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).connect(
    providerChain3,
  );

  const ownerAddress = walletChain2.address;

  const evmChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );
  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  const [chain2Addresses, chain3Addresses] = await Promise.all([
    evmChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
  ]);

  const tokenChain2 = await deployToken(
    HYP_KEY_BY_PROTOCOL.ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );
  const vaultChain2 = await deploy4626Vault(
    HYP_KEY_BY_PROTOCOL.ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    tokenChain2.address,
  );

  const [tokenChain2Symbol, tokenVaultChain2Symbol] = await Promise.all([
    tokenChain2.symbol(),
    vaultChain2.symbol(),
  ]);

  const tokenChain3 = await deployToken(
    HYP_KEY_BY_PROTOCOL.ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );
  const vaultChain3 = await deploy4626Vault(
    HYP_KEY_BY_PROTOCOL.ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    tokenChain3.address,
  );

  const [tokenChain3Symbol, tokenVaultChain3Symbol] = await Promise.all([
    tokenChain3.symbol(),
    vaultChain3.symbol(),
  ]);

  return {
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
  };
}

export function generateTestCases(
  config: WarpBridgeTestConfig,
  divideBy: number,
  index: number,
): ReadonlyArray<WarpRouteDeployConfig> {
  const warpConfigTestCases = generateWarpConfigs(
    {
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      mailbox: config.chain2Addresses.mailbox,
      owner: config.ownerAddress,
      token: config.tokenChain2.address,
      vault: config.vaultChain2.address,
    },
    {
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      mailbox: config.chain3Addresses.mailbox,
      owner: config.ownerAddress,
      token: config.tokenChain3.address,
      vault: config.vaultChain3.address,
    },
  );

  const chunkSize = Math.ceil(warpConfigTestCases.length / divideBy);
  const start = index * chunkSize;
  const end = Math.min(start + chunkSize, warpConfigTestCases.length);
  return warpConfigTestCases.slice(start, end);
}

export function getTokenSymbolFromDeployment(
  warpConfig: WarpRouteDeployConfig,
  tokenVaultChain2Symbol: string,
  tokenChain2Symbol: string,
  tokenVaultChain3Symbol: string,
  tokenChain3Symbol: string,
): string {
  let symbol: string;
  if (
    warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type.match(
      /.*vault.*/i,
    )
  ) {
    symbol = tokenVaultChain2Symbol;
  } else if (
    warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].type.match(
      /.*native.*/i,
    )
  ) {
    symbol = 'ETH';
  } else if (
    warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].type.match(
      /.*collateral.*/i,
    )
  ) {
    symbol = tokenChain2Symbol;
  } else if (
    warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].type.match(
      /.*vault.*/i,
    )
  ) {
    symbol = tokenVaultChain3Symbol;
  } else if (
    warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].type.match(
      /.*collateral.*/i,
    )
  ) {
    symbol = tokenChain3Symbol;
  } else {
    symbol = 'ETH';
  }

  return symbol;
}

export async function collateralizeWarpTokens(
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
    [
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    ]
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
          const decimals =
            await walletAndCollateralByChain[chainName].collateral.decimals();
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
