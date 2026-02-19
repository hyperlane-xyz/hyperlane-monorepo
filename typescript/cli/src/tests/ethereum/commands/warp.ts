import { Wallet, ethers } from 'ethers';
import { $, type ProcessOutput, type ProcessPromise } from 'zx';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainName,
  HypERC20Deployer,
  type HypTokenRouterConfig,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
  type WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import {
  assert,
  type Address,
  ProtocolType,
  randomInt,
} from '@hyperlane-xyz/utils';

import { readChainSubmissionStrategyConfig } from '../../../config/strategy.js';
import { createAltVMSigners } from '../../../context/altvm.js';
import { getContext } from '../../../context/context.js';
import { type CommandContext } from '../../../context/types.js';
import { warpRouteIdFromFileName } from '../../../deploy/utils.js';
import { extendWarpRoute as extendWarpRouteWithoutApplyTransactions } from '../../../deploy/warp.js';
import {
  isFile,
  readYamlOrJson,
  writeYamlOrJson,
} from '../../../utils/files.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  REGISTRY_PATH,
  TEMP_PATH,
  WARP_CORE_CONFIG_PATH_2,
  getCombinedWarpRoutePath,
  getWarpRouteId,
} from '../consts.js';

import {
  getDeployedWarpAddress,
  getDomainId,
  localTestRunCmdPrefix,
} from './helpers.js';
import { syncWarpDeployConfigToRegistry as syncWarpDeployConfigToRegistryShared } from '../../commands/warp-config-sync.js';

$.verbose = true;

export function syncWarpDeployConfigToRegistry(
  warpDeployPath: string,
  warpRouteId: string,
): string {
  return syncWarpDeployConfigToRegistryShared({
    warpDeployPath,
    warpRouteId,
    registryPath: REGISTRY_PATH,
  });
}

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

export function hyperlaneWarpInit(warpCorePath: string): ProcessPromise {
  return hyperlaneWarpInitRaw({
    privateKey: ANVIL_KEY,
    warpCorePath: warpCorePath,
    skipConfirmationPrompts: true,
  });
}

export function hyperlaneWarpDeployRaw({
  hypKey,
  skipConfirmationPrompts,
  privateKey,
  warpRouteId,
}: {
  hypKey?: string;
  skipConfirmationPrompts?: boolean;
  privateKey?: string;
  warpRouteId?: string;
}): ProcessPromise {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : []
  } ${localTestRunCmdPrefix()} hyperlane warp deploy \
        --registry ${REGISTRY_PATH} \
        ${privateKey ? ['--key', privateKey] : []} \
        --verbosity debug \
        ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
        ${skipConfirmationPrompts ? ['--yes'] : []}`;
}

function hasSymbol(config: unknown): config is { symbol: string } {
  return (
    typeof config === 'object' &&
    config !== null &&
    'symbol' in config &&
    typeof (config as { symbol?: unknown }).symbol === 'string'
  );
}

function hasTokenAddress(config: unknown): config is { token: string } {
  return (
    typeof config === 'object' &&
    config !== null &&
    'token' in config &&
    typeof (config as { token?: unknown }).token === 'string'
  );
}

async function resolveWarpRouteSymbolFromConfig(
  warpDeployConfig: WarpRouteDeployConfig,
): Promise<string | undefined> {
  let cachedContext: Awaited<ReturnType<typeof getContext>> | undefined;
  const getCachedContext = async () => {
    if (!cachedContext) {
      cachedContext = await getContext({
        registryUris: [REGISTRY_PATH],
        key: ANVIL_KEY,
      });
    }
    return cachedContext;
  };

  for (const config of Object.values(warpDeployConfig)) {
    if (hasSymbol(config)) {
      return config.symbol;
    }
  }

  try {
    const { multiProvider } = await getCachedContext();
    const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
      multiProvider,
      warpDeployConfig,
    );
    return tokenMetadata.getDefaultSymbol();
  } catch (error: unknown) {
    console.warn(
      `[resolveWarpRouteSymbolFromConfig] token metadata derivation failed for registry "${REGISTRY_PATH}". Falling back to RPC symbol lookup.`,
      error,
    );
  }

  let tokenChain: string | undefined;
  let tokenAddress: string | undefined;
  for (const [chainName, config] of Object.entries(warpDeployConfig)) {
    if (hasTokenAddress(config)) {
      tokenChain = chainName;
      tokenAddress = config.token;
      break;
    }
  }
  if (!tokenChain || !tokenAddress) {
    return undefined;
  }

  try {
    const { multiProvider } = await getCachedContext();
    const provider = multiProvider.getProvider(tokenChain);
    const erc20 = new ethers.Contract(
      tokenAddress,
      ['function symbol() view returns (string)'],
      provider,
    );
    return await erc20.symbol();
  } catch (error: unknown) {
    console.warn(
      `[resolveWarpRouteSymbolFromConfig] RPC symbol() lookup failed for chain "${tokenChain}" token "${tokenAddress}".`,
      error,
    );
    return undefined;
  }
}

type ResolveWarpRouteIdForDeployOptions = {
  warpDeployPath?: string;
  warpRouteId?: string;
};

export async function resolveWarpRouteIdForDeploy(
  options: ResolveWarpRouteIdForDeployOptions,
): Promise<string> {
  const { warpDeployPath, warpRouteId } = options;
  assert(
    warpDeployPath || warpRouteId,
    'Either warpDeployPath or warpRouteId must be provided',
  );

  if (!warpDeployPath) {
    assert(
      warpRouteId,
      'warpRouteId is required when warpDeployPath is omitted',
    );
    return warpRouteId;
  }

  if (warpRouteId) {
    syncWarpDeployConfigToRegistry(warpDeployPath, warpRouteId);
    return warpRouteId;
  }

  const config = readYamlOrJson(warpDeployPath) as WarpRouteDeployConfig;
  const symbol = await resolveWarpRouteSymbolFromConfig(config);
  assert(
    symbol && symbol.length > 0,
    `[resolveWarpRouteIdForDeploy] could not resolve token symbol from "${warpDeployPath}". Add a symbol field or pass --warp-route-id explicitly.`,
  );
  const resolvedWarpRouteId = warpRouteIdFromFileName(warpDeployPath, symbol);
  syncWarpDeployConfigToRegistry(warpDeployPath, resolvedWarpRouteId);
  return resolvedWarpRouteId;
}

/**
 * Deploys a warp route in e2e tests.
 *
 * `warpDeployPathOrWarpRouteId` is interpreted as:
 * - deploy config path, when it points to an existing file (`isFile(...)`)
 * - warp route ID otherwise
 *
 * If `warpRouteId` is provided, `warpDeployPathOrWarpRouteId` is treated as
 * the deploy config path and synced to that explicit route ID.
 */
export async function hyperlaneWarpDeploy(
  warpDeployPathOrWarpRouteId: string,
  warpRouteId?: string,
): Promise<ProcessOutput> {
  const resolvedWarpRouteId = warpRouteId
    ? await resolveWarpRouteIdForDeploy({
        warpDeployPath: warpDeployPathOrWarpRouteId,
        warpRouteId,
      })
    : isFile(warpDeployPathOrWarpRouteId)
      ? await resolveWarpRouteIdForDeploy({
          warpDeployPath: warpDeployPathOrWarpRouteId,
        })
      : await resolveWarpRouteIdForDeploy({
          warpRouteId: warpDeployPathOrWarpRouteId,
        });

  return hyperlaneWarpDeployRaw({
    privateKey: ANVIL_KEY,
    skipConfirmationPrompts: true,
    warpRouteId: resolvedWarpRouteId,
  });
}

export async function hyperlaneWarpApply(
  warpRouteId: string,
  strategyUrl = '',
  relay = false,
) {
  return hyperlaneWarpApplyRaw({
    strategyUrl,
    relay,
    warpRouteId,
  });
}

export function hyperlaneWarpApplyRaw({
  strategyUrl,
  warpRouteId,
  relay,
}: {
  strategyUrl?: string;
  warpRouteId?: string;
  relay?: boolean;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp apply \
        --registry ${REGISTRY_PATH} \
        ${strategyUrl ? ['--strategy', strategyUrl] : []} \
        ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        ${relay ? ['--relay'] : []} \
        --yes`;
}

export function hyperlaneWarpReadRaw({
  chain,
  warpAddress,
  outputPath,
  warpRouteId,
}: {
  chain?: string;
  warpAddress?: string;
  outputPath?: string;
  warpRouteId?: string;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp read \
        --registry ${REGISTRY_PATH} \
        ${warpAddress ? ['--address', warpAddress] : []} \
        ${chain ? ['--chain', chain] : []} \
        ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
        --verbosity debug \
        ${outputPath ? ['--out', outputPath] : []}`;
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
  warpRouteId,
  ica,
  origin,
  originOwner,
  chains,
}: {
  warpRouteId?: string;
  ica?: boolean;
  origin?: string;
  originOwner?: string;
  chains?: string[];
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp check \
        --registry ${REGISTRY_PATH} \
        --verbosity debug \
        ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
        ${ica ? ['--ica'] : []} \
        ${origin ? ['--origin', origin] : []} \
        ${originOwner ? ['--originOwner', originOwner] : []} \
        ${chains?.length ? chains.flatMap((d) => ['--chains', d]) : []}`;
}

export function hyperlaneWarpCheck(warpRouteId: string): ProcessPromise {
  return hyperlaneWarpCheckRaw({
    warpRouteId,
  });
}

export function hyperlaneWarpSendRelay({
  origin,
  destination,
  warpRouteId,
  relay = true,
  value = 2,
  chains,
  roundTrip,
}: {
  origin?: string;
  destination?: string;
  warpRouteId: string;
  relay?: boolean;
  value?: number | string;
  chains?: string[];
  roundTrip?: boolean;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp send \
        ${relay ? '--relay' : []} \
        --registry ${REGISTRY_PATH} \
        ${origin ? ['--origin', origin] : []} \
        ${destination ? ['--destination', destination] : []} \
        --warp-route-id ${warpRouteId} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes \
        --amount ${value} \
        ${chains?.length ? chains.flatMap((c) => ['--chains', c]) : []} \
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

type ReadWarpConfigOptions = {
  // Preserve chains not returned by `warp read` (which may only output the queried chain).
  preserveExistingChains?: boolean;
};

export async function readWarpConfig(
  chain: string,
  warpCorePath: string,
  warpDeployPath: string,
  options: ReadWarpConfigOptions = {},
): Promise<WarpRouteDeployConfigMailboxRequired> {
  const { preserveExistingChains = true } = options;
  const existingConfig =
    preserveExistingChains && isFile(warpDeployPath)
      ? (readYamlOrJson(warpDeployPath) as WarpRouteDeployConfig)
      : undefined;
  const warpAddress = getDeployedWarpAddress(chain, warpCorePath);
  await hyperlaneWarpRead(chain, warpAddress!, warpDeployPath);
  const freshConfig = readYamlOrJson(warpDeployPath) as WarpRouteDeployConfig;
  const freshReadChains = Object.keys(freshConfig);
  assert(
    freshReadChains.length > 0,
    `[readWarpConfig] no chains found in fresh read output at ${warpDeployPath}`,
  );

  const mergedConfig: WarpRouteDeployConfig = { ...freshConfig };
  if (existingConfig) {
    for (const [existingChain, config] of Object.entries(existingConfig)) {
      if (!(existingChain in mergedConfig)) {
        mergedConfig[existingChain] = config;
      }
    }
  }

  const missingMailboxChains: string[] = [];
  for (const configChain of freshReadChains) {
    const config = mergedConfig[configChain];
    const mailbox = (config as { mailbox?: string }).mailbox;
    if (!(typeof mailbox === 'string' && mailbox.length > 0)) {
      missingMailboxChains.push(configChain);
    }
  }
  assert(
    missingMailboxChains.length === 0,
    `[readWarpConfig] missing mailbox for chain(s) "${missingMailboxChains.join(', ')}" in ${warpDeployPath}`,
  );

  return mergedConfig as WarpRouteDeployConfigMailboxRequired;
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
    // Forward-compatibility placeholder, not deployable
    TokenType.unknown,
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

export async function updateOwner(
  owner: Address,
  chain: string,
  warpCorePath: string,
  warpDeployPath: string,
  warpRouteId: string,
) {
  await updateWarpOwnerConfig(chain, owner, warpCorePath, warpDeployPath);

  // Sync updated config to registry deploy path before applying
  syncWarpDeployConfigToRegistry(warpDeployPath, warpRouteId);

  return hyperlaneWarpApply(warpRouteId);
}

export async function extendWarpConfig(params: {
  chain: string;
  chainToExtend: string;
  extendedConfig: HypTokenRouterConfig;
  warpCorePath: string;
  warpDeployPath: string;
  strategyUrl?: string;
  warpRouteId: string;
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
  delete warpDeployConfig[chain].remoteRouters;
  delete warpDeployConfig[chain].destinationGas;

  writeYamlOrJson(warpDeployPath, warpDeployConfig);

  // Sync updated config to registry deploy path before applying
  syncWarpDeployConfigToRegistry(warpDeployPath, warpRouteId);

  await hyperlaneWarpApplyRaw({
    strategyUrl,
    warpRouteId,
  });

  return warpDeployPath;
}

export async function setupIncompleteWarpRouteExtension(
  chain2Addresses: ChainAddresses,
): Promise<{
  chain2DomainId: string;
  chain3DomainId: string;
  warpConfigPath: string;
  configToExtend: HypTokenRouterConfig;
  context: CommandContext;
  combinedWarpCorePath: string;
  combinedWarpRouteId: string;
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
  writeYamlOrJson(warpConfigPath, warpDeployConfig);

  const combinedWarpRouteId = getWarpRouteId('ETH', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);
  syncWarpDeployConfigToRegistry(warpConfigPath, combinedWarpRouteId);

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
    combinedWarpRouteId,
  };
}

export async function sendWarpRouteMessageRoundTrip(
  chain1: string,
  chain2: string,
  warpRouteId: string,
) {
  await hyperlaneWarpSendRelay({
    origin: chain1,
    destination: chain2,
    warpRouteId,
  });
  return hyperlaneWarpSendRelay({
    origin: chain2,
    destination: chain1,
    warpRouteId,
  });
}
