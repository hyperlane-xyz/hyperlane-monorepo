import { Wallet } from 'ethers';
import { $, ProcessPromise } from 'zx';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainName,
  HypTokenRouterConfig,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, randomInt } from '@hyperlane-xyz/utils';

import { readChainSubmissionStrategyConfig } from '../../../config/strategy.js';
import { createAltVMSigners } from '../../../context/altvm.js';
import { getContext } from '../../../context/context.js';
import { CommandContext } from '../../../context/types.js';
import { extendWarpRoute as extendWarpRouteWithoutApplyTransactions } from '../../../deploy/warp.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  REGISTRY_PATH,
  TEMP_PATH,
  WARP_CORE_CONFIG_PATH_2,
  getCombinedWarpRoutePath,
} from '../consts.js';

import {
  getDeployedWarpAddress,
  getDomainId,
  localTestRunCmdPrefix,
} from './helpers.js';

$.verbose = true;

/**
 * Creates a warp route configuration with raw parameters.
 */
export function hyperlaneWarpInitRaw({
  warpCorePath,
  hypKey,
  skipConfirmationPrompts,
  privateKey,
  advanced,
}: {
  warpCorePath?: string;
  hypKey?: string;
  skipConfirmationPrompts?: boolean;
  privateKey?: string;
  advanced?: boolean;
}): ProcessPromise {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : []
  } ${localTestRunCmdPrefix()} hyperlane warp init \
        --registry ${REGISTRY_PATH} \
        ${warpCorePath ? ['--out', warpCorePath] : []} \
        ${privateKey ? ['--key', privateKey] : []} \
        ${advanced ? ['--advanced'] : []} \
        --verbosity debug \
        ${skipConfirmationPrompts ? ['--yes'] : []}`;
}

/**
 * Creates a warp route configuration.
 */
export function hyperlaneWarpInit(warpCorePath: string): ProcessPromise {
  return hyperlaneWarpInitRaw({
    privateKey: ANVIL_KEY,
    warpCorePath: warpCorePath,
    skipConfirmationPrompts: true,
  });
}

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export function hyperlaneWarpDeployRaw({
  warpCorePath,
  warpDeployPath,
  hypKey,
  skipConfirmationPrompts,
  privateKey,
  warpRouteId,
}: {
  warpCorePath?: string;
  warpDeployPath?: string;
  hypKey?: string;
  skipConfirmationPrompts?: boolean;
  privateKey?: string;
  warpRouteId?: string;
}): ProcessPromise {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : []
  } ${localTestRunCmdPrefix()} hyperlane warp deploy \
        --registry ${REGISTRY_PATH} \
        ${warpDeployPath ? ['--config', warpDeployPath] : []} \
        ${warpCorePath ? ['--warp', warpCorePath] : []} \
        ${privateKey ? ['--key', privateKey] : []} \
        --verbosity debug \
        ${warpRouteId ? ['--warpRouteId', warpRouteId] : []} \
        ${skipConfirmationPrompts ? ['--yes'] : []}`;
}

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export function hyperlaneWarpDeploy(
  warpDeployPath: string,
  warpRouteId?: string,
): ProcessPromise {
  return hyperlaneWarpDeployRaw({
    privateKey: ANVIL_KEY,
    warpDeployPath,
    skipConfirmationPrompts: true,
    warpRouteId,
  });
}

/**
 * Applies updates to the Warp route config.
 */
export async function hyperlaneWarpApply(
  warpDeployPath: string,
  warpCorePath: string,
  strategyUrl = '',
  warpRouteId?: string,
  relay = false,
) {
  return hyperlaneWarpApplyRaw({
    warpDeployPath,
    warpCorePath,
    strategyUrl,
    relay,
    warpRouteId,
  });
}

export function hyperlaneWarpApplyRaw({
  warpDeployPath,
  warpCorePath,
  strategyUrl,
  warpRouteId,
  relay,
}: {
  warpDeployPath?: string;
  warpCorePath?: string;
  strategyUrl?: string;
  warpRouteId?: string;
  relay?: boolean;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp apply \
        --registry ${REGISTRY_PATH} \
        ${warpDeployPath ? ['--config', warpDeployPath] : []} \
        ${warpCorePath ? ['--warp', warpCorePath] : []} \
        ${strategyUrl ? ['--strategy', strategyUrl] : []} \
        ${warpRouteId ? ['--warpRouteId', warpRouteId] : []} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        ${relay ? ['--relay'] : []} \
        --yes`;
}

export function hyperlaneWarpReadRaw({
  chain,
  warpAddress,
  outputPath,
  symbol,
}: {
  chain?: string;
  symbol?: string;
  warpAddress?: string;
  outputPath?: string;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp read \
        --registry ${REGISTRY_PATH} \
        ${warpAddress ? ['--address', warpAddress] : []} \
        ${chain ? ['--chain', chain] : []} \
        ${symbol ? ['--symbol', symbol] : []} \
        --verbosity debug \
        ${outputPath ? ['--config', outputPath] : []}`;
}

export function hyperlaneWarpRead(
  chain: string,
  warpAddress: string,
  warpDeployPath: string,
): ProcessPromise {
  return hyperlaneWarpReadRaw({
    chain,
    warpAddress,
    outputPath: warpDeployPath,
  });
}

export function hyperlaneWarpCheckRaw({
  warpDeployPath,
  symbol,
  warpCoreConfigPath,
  warpRouteId,
}: {
  symbol?: string;
  warpDeployPath?: string;
  warpCoreConfigPath?: string;
  warpRouteId?: string;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp check \
        --registry ${REGISTRY_PATH} \
        ${symbol ? ['--symbol', symbol] : []} \
        --verbosity debug \
        ${warpDeployPath ? ['--config', warpDeployPath] : []} \
        ${warpCoreConfigPath ? ['--warp', warpCoreConfigPath] : []} \
        ${warpRouteId ? ['--warpRouteId', warpRouteId] : []}`;
}

export function hyperlaneWarpCheck(
  warpDeployPath: string,
  symbol: string,
  warpCoreConfigPath?: string,
): ProcessPromise {
  return hyperlaneWarpCheckRaw({
    warpDeployPath,
    symbol,
    warpCoreConfigPath,
  });
}

export function hyperlaneWarpSendRelay({
  origin,
  destination,
  warpCorePath,
  relay = true,
  value = 2,
  chains,
  roundTrip,
}: {
  origin?: string;
  destination?: string;
  warpCorePath: string;
  relay?: boolean;
  value?: number | string;
  chains?: string;
  roundTrip?: boolean;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp send \
        ${relay ? '--relay' : []} \
        --registry ${REGISTRY_PATH} \
        ${origin ? ['--origin', origin] : []} \
        ${destination ? ['--destination', destination] : []} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes \
        --amount ${value} \
        ${chains ? ['--chains', chains] : []} \
        ${roundTrip ? ['--round-trip'] : []} `;
}

export function hyperlaneWarpRebalancer(
  checkFrequency: number,
  config: string,
  withMetrics: boolean,
  monitorOnly?: boolean,
  manual?: boolean,
  origin?: string,
  destination?: string,
  amount?: string,
  key?: string,
  explorerUrl?: string,
): ProcessPromise {
  const rebalancerAddress = key
    ? new Wallet(key).address
    : ANVIL_DEPLOYER_ADDRESS;
  return $`${explorerUrl ? [`EXPLORER_API_URL=${explorerUrl}`] : []} REBALANCER=${rebalancerAddress} ${localTestRunCmdPrefix()} hyperlane warp rebalancer \
        --registry ${REGISTRY_PATH} \
        --checkFrequency ${checkFrequency} \
        --config ${config} \
        --key ${key ?? ANVIL_KEY} \
        --verbosity debug \
        --withMetrics ${withMetrics ? ['true'] : ['false']} \
        --monitorOnly ${monitorOnly ? ['true'] : ['false']} \
        ${manual ? ['--manual'] : []} \
        ${origin ? ['--origin', origin] : []} \
        ${destination ? ['--destination', destination] : []} \
        ${amount ? ['--amount', amount] : []}`;
}

/**
 * Reads the Warp route deployment config to specified output path.
 * @param warpCorePath path to warp core
 * @param warpDeployPath path to output the resulting read
 * @returns The Warp route deployment config.
 */
export async function readWarpConfig(
  chain: string,
  warpCorePath: string,
  warpDeployPath: string,
): Promise<WarpRouteDeployConfigMailboxRequired> {
  const warpAddress = getDeployedWarpAddress(chain, warpCorePath);
  await hyperlaneWarpRead(chain, warpAddress!, warpDeployPath);
  return readYamlOrJson(warpDeployPath);
}

type GetWarpTokenConfigByTokenTypeOptions = {
  tokenType: TokenType;
  mailbox: Address;
  owner: Address;
  token: Address;
  vault: Address;
  otherChain: ChainName;
  everclearBridgeAdapter: Address;
};

function getWarpTokenConfigForType({
  mailbox,
  otherChain,
  owner,
  token,
  tokenType,
  vault,
  everclearBridgeAdapter,
}: GetWarpTokenConfigByTokenTypeOptions): HypTokenRouterConfig {
  let tokenConfig: HypTokenRouterConfig;
  switch (tokenType) {
    case TokenType.collateral:
      tokenConfig = {
        type: TokenType.collateral,
        mailbox,
        owner,
        token,
      };
      break;
    case TokenType.collateralVault:
      tokenConfig = {
        type: TokenType.collateralVault,
        mailbox,
        owner,
        token: vault,
      };
      break;
    case TokenType.collateralVaultRebase:
      tokenConfig = {
        type: TokenType.collateralVaultRebase,
        mailbox,
        owner,
        token: vault,
      };
      break;
    case TokenType.native:
      tokenConfig = {
        type: TokenType.native,
        mailbox,
        owner,
      };
      break;
    case TokenType.nativeScaled:
      tokenConfig = {
        type: TokenType.nativeScaled,
        mailbox,
        owner,
        scale: 1,
      };
      break;
    case TokenType.synthetic:
      tokenConfig = {
        type: TokenType.synthetic,
        mailbox,
        owner,
      };
      break;
    case TokenType.syntheticRebase:
      tokenConfig = {
        type: TokenType.syntheticRebase,
        mailbox,
        owner,
        collateralChainName: otherChain,
      };
      break;
    case TokenType.collateralEverclear:
      tokenConfig = {
        type: TokenType.collateralEverclear,
        mailbox,
        owner,
        token,
        everclearBridgeAddress: everclearBridgeAdapter,
        outputAssets: {},
        everclearFeeParams: {
          [10]: {
            deadline: Date.now(),
            fee: randomInt(10000000),
            signature: '0x42',
          },
        },
      };
      break;
    default:
      throw new Error(
        `Unsupported token type "${tokenType}" for random config generation`,
      );
  }

  return tokenConfig;
}

type GetWarpTokenConfigOptions = {
  mailbox: Address;
  owner: Address;
  token: Address;
  vault: Address;
  fiatToken: Address;
  xerc20: Address;
  xerc20Lockbox: Address;
  chainName: ChainName;
  everclearBridgeAdapter: Address;
};

export function generateWarpConfigs(
  chain1Config: GetWarpTokenConfigOptions,
  chain2Config: GetWarpTokenConfigOptions,
): ReadonlyArray<WarpRouteDeployConfig> {
  const ignoreTokenTypes: Set<TokenType> = new Set([
    TokenType.XERC20,
    TokenType.XERC20Lockbox,
    TokenType.collateralFiat,
    TokenType.collateralUri,
    TokenType.syntheticUri,
    // TODO Fix: sender not mailbox or relaying simply fails
    TokenType.collateralVault,
    TokenType.collateralCctp,
    TokenType.nativeOpL1,
    TokenType.nativeOpL2,
    // No adapter has been implemented yet
    TokenType.ethEverclear,
    TokenType.collateralEverclear,
  ]);

  const allowedWarpTokenTypes = Object.values(TokenType).filter(
    (tokenType) =>
      !ignoreTokenTypes.has(tokenType) && typeof tokenType === 'string',
  );

  const exists = new Set<string>([]);
  const configs: WarpRouteDeployConfig[] = allowedWarpTokenTypes
    .flatMap((tokenType) =>
      allowedWarpTokenTypes.map((otherTokenType) => {
        return {
          [chain1Config.chainName]: getWarpTokenConfigForType({
            ...chain1Config,
            tokenType: tokenType,
            otherChain: chain2Config.chainName,
          }),
          [chain2Config.chainName]: getWarpTokenConfigForType({
            ...chain2Config,
            tokenType: otherTokenType,
            otherChain: chain1Config.chainName,
          }),
        };
      }),
    )
    // Remove already existing config pairs
    .filter((config) => {
      const combinationId: string = [
        config[chain1Config.chainName].type,
        config[chain2Config.chainName].type,
      ]
        .sort()
        .join('');

      if (exists.has(combinationId)) {
        return false;
      }

      exists.add(combinationId);
      return true;
    })
    // Remove invalid configs
    .filter(
      (warpConfig) => WarpRouteDeployConfigSchema.safeParse(warpConfig).success,
    );

  return configs;
}

/**
 * Updates the owner of the Warp route deployment config, and then output to a file
 */
export async function updateWarpOwnerConfig(
  chain: string,
  owner: Address,
  warpCorePath: string,
  warpDeployPath: string,
): Promise<string> {
  const warpDeployConfig = await readWarpConfig(
    chain,
    warpCorePath,
    warpDeployPath,
  );
  warpDeployConfig[chain].owner = owner;
  await writeYamlOrJson(warpDeployPath, warpDeployConfig);

  return warpDeployPath;
}

/**
 * Updates the Warp route deployment configuration with a new owner, and then applies the changes.
 */
export async function updateOwner(
  owner: Address,
  chain: string,
  warpConfigPath: string,
  warpCoreConfigPath: string,
) {
  await updateWarpOwnerConfig(chain, owner, warpCoreConfigPath, warpConfigPath);
  return hyperlaneWarpApply(warpConfigPath, warpCoreConfigPath);
}

/**
 * Extends the Warp route deployment with a new warp config
 */
export async function extendWarpConfig(params: {
  chain: string;
  chainToExtend: string;
  extendedConfig: HypTokenRouterConfig;
  warpCorePath: string;
  warpDeployPath: string;
  strategyUrl?: string;
  warpRouteId?: string;
}): Promise<string> {
  const {
    chain,
    chainToExtend,
    extendedConfig,
    warpCorePath,
    warpDeployPath,
    strategyUrl,
    warpRouteId,
  } = params;
  const warpDeployConfig = await readWarpConfig(
    chain,
    warpCorePath,
    warpDeployPath,
  );
  warpDeployConfig[chainToExtend] = extendedConfig;
  // Remove remoteRouters and destinationGas as they are written in readWarpConfig
  delete warpDeployConfig[chain].remoteRouters;
  delete warpDeployConfig[chain].destinationGas;

  writeYamlOrJson(warpDeployPath, warpDeployConfig);
  await hyperlaneWarpApplyRaw({
    warpDeployPath,
    warpCorePath,
    strategyUrl,
    warpRouteId,
  });

  return warpDeployPath;
}

/**
 * Sets up an incomplete warp route extension for testing purposes.
 *
 * This function creates a new warp route configuration for the second chain.
 */
export async function setupIncompleteWarpRouteExtension(
  chain2Addresses: ChainAddresses,
): Promise<{
  chain2DomainId: string;
  chain3DomainId: string;
  warpConfigPath: string;
  configToExtend: HypTokenRouterConfig;
  context: CommandContext;
  combinedWarpCorePath: string;
}> {
  const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

  const chain2DomainId = await getDomainId(CHAIN_NAME_2, ANVIL_KEY);
  const chain3DomainId = await getDomainId(CHAIN_NAME_3, ANVIL_KEY);

  const configToExtend: HypTokenRouterConfig = {
    decimals: 18,
    mailbox: chain2Addresses!.mailbox,
    name: 'Ether',
    owner: new Wallet(ANVIL_KEY).address,
    symbol: 'ETH',
    type: TokenType.native,
  };

  const context = await getContext({
    registryUris: [REGISTRY_PATH],
    key: ANVIL_KEY,
  });

  const warpCoreConfig = readYamlOrJson(
    WARP_CORE_CONFIG_PATH_2,
  ) as WarpCoreConfig;
  const warpDeployConfig = await readWarpConfig(
    CHAIN_NAME_2,
    WARP_CORE_CONFIG_PATH_2,
    warpConfigPath,
  );

  warpDeployConfig[CHAIN_NAME_3] = configToExtend;

  const signer2 = new Wallet(
    ANVIL_KEY,
    context.multiProvider.getProvider(CHAIN_NAME_2),
  );
  const signer3 = new Wallet(
    ANVIL_KEY,
    context.multiProvider.getProvider(CHAIN_NAME_3),
  );
  context.multiProvider.setSigner(CHAIN_NAME_2, signer2);
  context.multiProvider.setSigner(CHAIN_NAME_3, signer3);

  const strategyConfig = context.strategyPath
    ? await readChainSubmissionStrategyConfig(context.strategyPath)
    : {};

  const altVmSigners = await createAltVMSigners(
    context.multiProvider,
    [],
    {},
    strategyConfig,
  );

  await extendWarpRouteWithoutApplyTransactions(
    {
      context: {
        ...context,
        signer: signer3,
        key: {
          [ProtocolType.Ethereum]: ANVIL_KEY,
        },
        altVmSigners,
      },
      warpCoreConfig,
      warpDeployConfig,
      receiptsDir: TEMP_PATH,
    },
    {},
    warpCoreConfig,
  );

  const combinedWarpCorePath = getCombinedWarpRoutePath('ETH', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);

  return {
    chain2DomainId,
    chain3DomainId,
    warpConfigPath,
    configToExtend,
    context,
    combinedWarpCorePath,
  };
}

/**
 * Performs a round-trip warp relay between two chains using the specified warp core config.
 *
 * @param chain1 - The first chain to send the warp relay from.
 * @param chain2 - The second chain to send the warp relay to and back from.
 * @param warpCoreConfigPath - The path to the warp core config file.
 * @returns A promise that resolves when the round-trip warp relay is complete.
 */
export async function sendWarpRouteMessageRoundTrip(
  chain1: string,
  chain2: string,
  warpCoreConfigPath: string,
) {
  await hyperlaneWarpSendRelay({
    origin: chain1,
    destination: chain2,
    warpCorePath: warpCoreConfigPath,
  });
  return hyperlaneWarpSendRelay({
    origin: chain2,
    destination: chain1,
    warpCorePath: warpCoreConfigPath,
  });
}
