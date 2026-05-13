import { readFileSync } from 'fs';

import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  SubmissionStrategy,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import relayerAddresses from '../../../../relayer.json' with { type: 'json' };
import { getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

const BLACKLIST_CSV_PATH = new URL(
  '../krown-blacklist-message-ids.csv',
  import.meta.url,
);

type KrownWarpRouteId =
  | WarpRouteIds.KrownETH
  | WarpRouteIds.KrownUSDC
  | WarpRouteIds.KrownUSDT;

const krownWarpRouteTokens: Record<KrownWarpRouteId, string> = {
  [WarpRouteIds.KrownETH]: 'ETH',
  [WarpRouteIds.KrownUSDC]: 'USDC',
  [WarpRouteIds.KrownUSDT]: 'USDT',
};

function getKrownBlacklistIdsByTokenAndChain(): Record<
  string,
  ChainMap<string[]>
> {
  const [headerLine, ...rows] = readFileSync(BLACKLIST_CSV_PATH, 'utf8')
    .trim()
    .split(/\r?\n/);

  assert(headerLine, `Missing header in ${BLACKLIST_CSV_PATH}`);

  const headers = headerLine.split(',').map((header) => header.trim());
  const messageIdIndex = headers.indexOf('post_reorg_message_id');
  const destinationIndex = headers.indexOf('destination');
  const existsPreReorgIndex = headers.indexOf('exists_pre_reorg');
  const tokenIndex = headers.indexOf('token');
  assert(
    messageIdIndex >= 0,
    `Missing post_reorg_message_id column in ${BLACKLIST_CSV_PATH}`,
  );
  assert(
    destinationIndex >= 0,
    `Missing destination column in ${BLACKLIST_CSV_PATH}`,
  );
  assert(
    existsPreReorgIndex >= 0,
    `Missing exists_pre_reorg column in ${BLACKLIST_CSV_PATH}`,
  );
  assert(tokenIndex >= 0, `Missing token column in ${BLACKLIST_CSV_PATH}`);

  const idsByTokenAndChain: Record<string, ChainMap<string[]>> = {};
  const seenByTokenAndChain: Record<string, ChainMap<Set<string>>> = {};

  for (const row of rows) {
    const columns = row.split(',');
    const existsPreReorg = columns[existsPreReorgIndex]?.trim().toUpperCase();
    if (existsPreReorg !== 'TRUE') continue;

    const token = columns[tokenIndex]?.trim().toUpperCase();
    const chain = columns[destinationIndex]?.trim();
    const messageId = columns[messageIdIndex]?.trim().toLowerCase();
    assert(token, `Missing token in ${BLACKLIST_CSV_PATH}`);
    assert(chain, `Missing destination in ${BLACKLIST_CSV_PATH}`);
    assert(messageId, `Missing post_reorg_message_id in ${BLACKLIST_CSV_PATH}`);
    assert(
      /^0x[0-9a-f]{64}$/.test(messageId),
      `Invalid Krown blacklist message ID: ${messageId}`,
    );

    idsByTokenAndChain[token] ??= {};
    idsByTokenAndChain[token][chain] ??= [];
    seenByTokenAndChain[token] ??= {};
    seenByTokenAndChain[token][chain] ??= new Set<string>();
    if (!seenByTokenAndChain[token][chain].has(messageId)) {
      seenByTokenAndChain[token][chain].add(messageId);
      idsByTokenAndChain[token][chain].push(messageId);
    }
  }

  return idsByTokenAndChain;
}

const krownBlacklistIdsByTokenAndChain = getKrownBlacklistIdsByTokenAndChain();
const trustedRelayer = relayerAddresses.mainnet3.hyperlane;
const krownOwnerSafeChain = 'ethereum';
const krownOwnerSafeAddress = '0x3Ea04C1cDDebf600dA09e6FE0654835F27258f30';
const krownWarpRouteChains: Record<KrownWarpRouteId, readonly string[]> = {
  [WarpRouteIds.KrownETH]: ['base', 'ethereum', 'krown'],
  [WarpRouteIds.KrownUSDC]: ['base', 'ethereum', 'krown'],
  [WarpRouteIds.KrownUSDT]: ['ethereum', 'krown'],
};

function getKrownBlacklistIsmConfig(params: {
  owner: string;
  blacklistedIds: string[];
}): IsmConfig {
  const { owner, blacklistedIds } = params;
  const modules: IsmConfig[] = [
    {
      type: IsmType.BLACKLIST,
      owner,
      blacklistedIds,
    },
    {
      type: IsmType.TRUSTED_RELAYER,
      relayer: trustedRelayer,
    },
    {
      type: IsmType.FALLBACK_ROUTING,
      owner,
      domains: {},
    },
  ];

  const krownOriginIsm: IsmConfig = {
    type: IsmType.AGGREGATION,
    modules,
    threshold: modules.length,
  };

  return {
    type: IsmType.FALLBACK_ROUTING,
    owner,
    domains: {
      krown: krownOriginIsm,
    },
  };
}

export async function getKrownWarpConfig(
  warpRouteId: KrownWarpRouteId,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const registry = getRegistry();
  const config = await getRegistry().getWarpDeployConfig(warpRouteId);
  assert(config, `Warp route deploy config not found: ${warpRouteId}`);
  const blacklistToken = krownWarpRouteTokens[warpRouteId];
  const krownBlacklistIdsByChain =
    krownBlacklistIdsByTokenAndChain[blacklistToken] ?? {};

  const result: ChainMap<HypTokenRouterConfig> = {};
  for (const [chain, chainConfig] of Object.entries(config)) {
    const mailbox = registry.getChainAddresses(chain)?.mailbox;
    assert(mailbox, `Mailbox not found for chain ${chain}`);

    const tokenConfig: HypTokenRouterConfig = {
      ...chainConfig,
      mailbox,
    };
    const blacklistedIds = krownBlacklistIdsByChain[chain];
    result[chain] = blacklistedIds?.length
      ? {
          ...tokenConfig,
          interchainSecurityModule: getKrownBlacklistIsmConfig({
            owner: tokenConfig.owner,
            blacklistedIds,
          }),
        }
      : tokenConfig;
  }

  return result;
}

export const getKrownETHWarpConfig = () =>
  getKrownWarpConfig(WarpRouteIds.KrownETH);

export const getKrownUSDCWarpConfig = () =>
  getKrownWarpConfig(WarpRouteIds.KrownUSDC);

export const getKrownUSDTWarpConfig = () =>
  getKrownWarpConfig(WarpRouteIds.KrownUSDT);

export function getKrownWarpStrategyConfig(
  warpRouteId: KrownWarpRouteId,
): ChainSubmissionStrategy {
  const originSafeSubmitter = {
    type: TxSubmitterType.GNOSIS_SAFE as const,
    chain: krownOwnerSafeChain,
    safeAddress: krownOwnerSafeAddress,
  };

  const icaStrategies: [string, SubmissionStrategy][] = krownWarpRouteChains[
    warpRouteId
  ]
    .filter((chain) => chain !== krownOwnerSafeChain)
    .map((chain) => [
      chain,
      {
        submitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT as const,
          chain: krownOwnerSafeChain,
          destinationChain: chain,
          owner: krownOwnerSafeAddress,
          internalSubmitter: originSafeSubmitter,
        },
      },
    ]);

  return Object.fromEntries([
    [krownOwnerSafeChain, { submitter: originSafeSubmitter }],
    ...icaStrategies,
  ]);
}

export const getKrownETHStrategyConfig = () =>
  getKrownWarpStrategyConfig(WarpRouteIds.KrownETH);

export const getKrownUSDCStrategyConfig = () =>
  getKrownWarpStrategyConfig(WarpRouteIds.KrownUSDC);

export const getKrownUSDTStrategyConfig = () =>
  getKrownWarpStrategyConfig(WarpRouteIds.KrownUSDT);
