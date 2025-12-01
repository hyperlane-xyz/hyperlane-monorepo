import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from 'ethers';
import { parseUnits } from 'ethers/lib/utils.js';

import {
  ERC20Test,
  ERC20Test__factory,
  ERC4626Test,
  FiatTokenTest,
  MockEverclearAdapter,
  XERC20LockboxTest,
  XERC20VSTest,
} from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  Token,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  deploy4626Vault,
  deployEverclearBridgeAdapter,
  deployFiatToken,
  deployToken,
  deployXERC20LockboxToken,
  deployXERC20VSToken,
  getTokenAddressFromWarpConfig,
} from '../commands/helpers.js';
import {
  generateWarpConfigs,
  hyperlaneWarpDeploy,
  sendWarpRouteMessageRoundTrip,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  REGISTRY_PATH,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../consts.js';

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
  fiatToken2: FiatTokenTest;
  xERC202: XERC20VSTest;
  xERC20Lockbox2: XERC20LockboxTest;
  vaultChain2: ERC4626Test;
  tokenChain3: ERC20Test;
  fiatToken3: FiatTokenTest;
  xERC203: XERC20VSTest;
  xERC20Lockbox3: XERC20LockboxTest;
  vaultChain3: ERC4626Test;
  everclearBridgeAdapterChain2: MockEverclearAdapter;
  everclearBridgeAdapterChain3: MockEverclearAdapter;
};

export async function runWarpBridgeTests(
  config: WarpBridgeTestConfig,
  warpConfigTestCases: ReadonlyArray<WarpRouteDeployConfig>,
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
    const symbol = getTokenSymbolFromDeployment(
      warpConfig,
      config.tokenVaultChain2Symbol,
      config.tokenChain2Symbol,
      config.tokenVaultChain3Symbol,
      config.tokenChain3Symbol,
    );
    const warpRouteId = `${symbol}/hyperlane`;
    const routeConfigPath = `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}-config.yaml`;

    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, warpRouteId);

    let startChain, targetChain: string;
    if (!warpConfig[CHAIN_NAME_2].type.match(/.*synthetic.*/i)) {
      startChain = CHAIN_NAME_2;
      targetChain = CHAIN_NAME_3;
    } else {
      startChain = CHAIN_NAME_3;
      targetChain = CHAIN_NAME_2;
    }

    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(routeConfigPath);
    if (warpConfig[CHAIN_NAME_2].type.match(/.*xerc20.*/i)) {
      const tx = await config.xERC202.addBridge({
        bridge: getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_2),
        bufferCap: 20000000000000,
        rateLimitPerSecond: 5000000000,
      });

      await tx.wait();
    }

    if (warpConfig[CHAIN_NAME_3].type.match(/.*xerc20.*/i)) {
      const tx = await config.xERC203.addBridge({
        bridge: getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_3),
        bufferCap: 20000000000000,
        rateLimitPerSecond: 5000000000,
      });

      await tx.wait();
    }

    await collateralizeWarpTokens(routeConfigPath, warpConfig, {
      [CHAIN_NAME_2]: {
        wallet: config.walletChain2,
        collateral: config.tokenChain2,
        xerc20Lockbox: config.xERC20Lockbox2,
      },
      [CHAIN_NAME_3]: {
        wallet: config.walletChain3,
        collateral: config.tokenChain3,
        xerc20Lockbox: config.xERC20Lockbox3,
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

export async function setupChains(): Promise<WarpBridgeTestConfig> {
  const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
  const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

  const providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
  const providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

  const walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
  const walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);

  const ownerAddress = walletChain2.address;

  const [chain2Addresses, chain3Addresses] = await Promise.all([
    deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
    deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
  ]);

  const tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
  const fiatToken2 = await deployFiatToken(ANVIL_KEY, CHAIN_NAME_2);
  const xERC202 = await deployXERC20VSToken(ANVIL_KEY, CHAIN_NAME_2);
  const xERC20Lockbox2 = await deployXERC20LockboxToken(
    ANVIL_KEY,
    CHAIN_NAME_2,
    tokenChain2,
  );
  const vaultChain2 = await deploy4626Vault(
    ANVIL_KEY,
    CHAIN_NAME_2,
    tokenChain2.address,
  );

  const [tokenChain2Symbol, tokenVaultChain2Symbol] = await Promise.all([
    tokenChain2.symbol(),
    vaultChain2.symbol(),
  ]);

  const everclearBridgeAdapterChain2 = await deployEverclearBridgeAdapter(
    ANVIL_KEY,
    CHAIN_NAME_2,
    REGISTRY_PATH,
  );

  const tokenChain3 = await deployToken(ANVIL_KEY, CHAIN_NAME_3);
  const fiatToken3 = await deployFiatToken(ANVIL_KEY, CHAIN_NAME_3);
  const xERC203 = await deployXERC20VSToken(ANVIL_KEY, CHAIN_NAME_3);
  const xERC20Lockbox3 = await deployXERC20LockboxToken(
    ANVIL_KEY,
    CHAIN_NAME_3,
    tokenChain3,
  );
  const vaultChain3 = await deploy4626Vault(
    ANVIL_KEY,
    CHAIN_NAME_3,
    tokenChain3.address,
  );

  const [tokenChain3Symbol, tokenVaultChain3Symbol] = await Promise.all([
    tokenChain3.symbol(),
    vaultChain3.symbol(),
  ]);

  const everclearBridgeAdapterChain3 = await deployEverclearBridgeAdapter(
    ANVIL_KEY,
    CHAIN_NAME_3,
    REGISTRY_PATH,
  );

  return {
    chain2Addresses,
    chain3Addresses,
    ownerAddress,
    walletChain2,
    walletChain3,
    tokenChain2,
    fiatToken2,
    xERC202,
    xERC20Lockbox2,
    tokenChain2Symbol,
    vaultChain2,
    tokenVaultChain2Symbol,
    tokenChain3,
    fiatToken3,
    xERC203,
    xERC20Lockbox3,
    tokenChain3Symbol,
    vaultChain3,
    tokenVaultChain3Symbol,
    everclearBridgeAdapterChain2,
    everclearBridgeAdapterChain3,
  };
}

export function generateTestCases(
  config: WarpBridgeTestConfig,
  divideBy: number,
  index: number,
): ReadonlyArray<WarpRouteDeployConfig> {
  const warpConfigTestCases = generateWarpConfigs(
    {
      chainName: CHAIN_NAME_2,
      mailbox: config.chain2Addresses.mailbox,
      owner: config.ownerAddress,
      token: config.tokenChain2.address,
      vault: config.vaultChain2.address,
      fiatToken: config.fiatToken2.address,
      xerc20: config.xERC202.address,
      xerc20Lockbox: config.xERC20Lockbox2.address,
      everclearBridgeAdapter: config.everclearBridgeAdapterChain2.address,
    },
    {
      chainName: CHAIN_NAME_3,
      mailbox: config.chain3Addresses.mailbox,
      owner: config.ownerAddress,
      token: config.tokenChain3.address,
      vault: config.vaultChain3.address,
      fiatToken: config.fiatToken3.address,
      xerc20: config.xERC203.address,
      xerc20Lockbox: config.xERC20Lockbox3.address,
      everclearBridgeAdapter: config.everclearBridgeAdapterChain3.address,
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
  if (warpConfig[CHAIN_NAME_2].type.match(/.*vault.*/i)) {
    symbol = tokenVaultChain2Symbol;
  } else if (warpConfig[CHAIN_NAME_3].type.match(/.*native.*/i)) {
    symbol = 'ETH';
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

export async function collateralizeWarpTokens(
  routeConfigPath: string,
  warpDeployConfig: WarpRouteDeployConfig,
  walletAndCollateralByChain: ChainMap<{
    wallet: Wallet;
    collateral: ERC20Test;
    xerc20Lockbox: XERC20LockboxTest;
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
          const decimals =
            await walletAndCollateralByChain[chainName].collateral.decimals();
          const tx = await walletAndCollateralByChain[
            chainName
          ].collateral.transfer(
            config[chainName].addressOrDenom,
            parseUnits('2', decimals),
          );

          await tx.wait();
        }

        if (warpDeployConfig[chainName].type === TokenType.XERC20Lockbox) {
          const lockbox = walletAndCollateralByChain[chainName].xerc20Lockbox;

          const lockboxCollateral = await lockbox.ERC20();
          const collateralInstance = ERC20Test__factory.connect(
            lockboxCollateral,
            walletAndCollateralByChain[chainName].wallet,
          );

          const decimals = await collateralInstance.decimals();
          const tx = await collateralInstance.transfer(
            lockbox.address,
            parseUnits('1', decimals),
          );

          await tx.wait();
        }
      }),
  );
}
