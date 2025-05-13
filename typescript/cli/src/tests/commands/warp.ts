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

import { ANVIL_KEY, REGISTRY_PATH, getDeployedWarpAddress } from './helpers.js';

$.verbose = true;

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export function hyperlaneWarpInit(warpCorePath: string): ProcessPromise {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp init \
        --registry ${REGISTRY_PATH} \
        --out ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export function hyperlaneWarpDeployRaw({
  warpCorePath,
  hypKey,
  skipConfirmationPrompts,
  privateKey,
}: {
  warpCorePath?: string;
  hypKey?: string;
  skipConfirmationPrompts?: boolean;
  privateKey?: string;
}): ProcessPromise {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : ''
  } yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
        --registry ${REGISTRY_PATH} \
        ${warpCorePath ? ['--config', warpCorePath] : ''} \
        ${privateKey ? ['--key', privateKey] : ''} \
        --verbosity debug \
        ${skipConfirmationPrompts ? ['--yes'] : ''}`;
}

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export function hyperlaneWarpDeploy(warpCorePath: string): ProcessPromise {
  return hyperlaneWarpDeployRaw({
    privateKey: ANVIL_KEY,
    warpCorePath: warpCorePath,
    skipConfirmationPrompts: true,
  });
}

/**
 * Applies updates to the Warp route config.
 */
export async function hyperlaneWarpApply(
  warpDeployPath: string,
  warpCorePath: string,
  strategyUrl = '',
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp apply \
        --registry ${REGISTRY_PATH} \
        --config ${warpDeployPath} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --strategy ${strategyUrl} \
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
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp read \
        --registry ${REGISTRY_PATH} \
        ${warpAddress ? ['--address', warpAddress] : ''} \
        ${chain ? ['--chain', chain] : ''} \
        ${symbol ? ['--symbol', symbol] : ''} \
        --verbosity debug \
        ${outputPath ? ['--config', outputPath] : ''}`;
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
}: {
  symbol?: string;
  warpDeployPath?: string;
}): ProcessPromise {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp check \
        --registry ${REGISTRY_PATH} \
        ${symbol ? ['--symbol', symbol] : ''} \
        --verbosity debug \
        ${warpDeployPath ? ['--config', warpDeployPath] : ''}`;
}

export function hyperlaneWarpCheck(
  warpDeployPath: string,
  symbol: string,
): ProcessPromise {
  return hyperlaneWarpCheckRaw({
    warpDeployPath,
    symbol,
  });
}

export function hyperlaneWarpSendRelay(
  origin: string,
  destination: string,
  warpCorePath: string,
  relay = true,
  value: number | string = 1,
): ProcessPromise {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp send \
        ${relay ? '--relay' : ''} \
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
  warpRouteId: string,
  checkFrequency: number,
  configFile: string,
  withMetrics: boolean,
  strategyType?: string,
): ProcessPromise {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp rebalancer \
        --registry ${REGISTRY_PATH} \
        --warpRouteId ${warpRouteId} \
        --checkFrequency ${checkFrequency} \
        --configFile ${configFile} \
        --key ${ANVIL_KEY} \
        ${withMetrics ? '--withMetrics' : ''} \
        ${strategyType ? `--strategyType ${strategyType}` : ''}`;
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
    case TokenType.fastCollateral:
      tokenConfig = {
        type: TokenType.fastCollateral,
        mailbox,
        owner,
        token,
      };
      break;
    case TokenType.fastSynthetic:
      tokenConfig = {
        type: TokenType.fastSynthetic,
        mailbox,
        owner,
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
