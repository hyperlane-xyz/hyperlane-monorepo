import { $, ProcessPromise } from 'zx';

import {
  ChainName,
  HypTokenRouterConfig,
  TokenType,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

import {
  ANVIL_KEY,
  REGISTRY_PATH,
  getDeployedWarpAddress,
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
) {
  return hyperlaneWarpApplyRaw({
    warpDeployPath,
    warpCorePath,
    strategyUrl,
    warpRouteId,
  });
}

export function hyperlaneWarpApplyRaw({
  warpDeployPath,
  warpCorePath,
  strategyUrl,
  warpRouteId,
}: {
  warpDeployPath?: string;
  warpCorePath?: string;
  strategyUrl?: string;
  warpRouteId?: string;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp apply \
        --registry ${REGISTRY_PATH} \
        ${warpDeployPath ? ['--config', warpDeployPath] : []} \
        ${warpCorePath ? ['--warp', warpCorePath] : []} \
        ${strategyUrl ? ['--strategy', strategyUrl] : []} \
        ${warpRouteId ? ['--warpRouteId', warpRouteId] : []} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
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

export function hyperlaneWarpSendRelay(
  origin: string,
  destination: string,
  warpCorePath: string,
  relay = true,
  value: number | string = 1,
): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane warp send \
        ${relay ? '--relay' : []} \
        --registry ${REGISTRY_PATH} \
        --origin ${origin} \
        --destination ${destination} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes \
        --amount ${value}`;
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
): ProcessPromise {
  return $`LOG_LEVEL=debug LOG_FORMAT=pretty yarn workspace @hyperlane-xyz/cli run hyperlane warp rebalancer \
        --registry ${REGISTRY_PATH} \
        --checkFrequency ${checkFrequency} \
        --config ${config} \
        --key ${ANVIL_KEY} \
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
};

function getWarpTokenConfigForType({
  mailbox,
  otherChain,
  owner,
  token,
  tokenType,
  vault,
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
  chainName: ChainName;
};

export function generateWarpConfigs(
  chain1Config: GetWarpTokenConfigOptions,
  chain2Config: GetWarpTokenConfigOptions,
): ReadonlyArray<WarpRouteDeployConfig> {
  const ignoreTokenTypes = new Set([
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
