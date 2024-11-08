import { PopulatedTransaction } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  IHypXERC20Adapter,
  MultiProtocolProvider,
  RouterConfig,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap, objMerge } from '@hyperlane-xyz/utils';

import { getWarpCoreConfig } from '../../../config/registry.js';
import {
  DeployEnvironment,
  getRouterConfigsForAllVms,
} from '../../../src/config/environment.js';
import { fetchGCPSecret } from '../../../src/utils/gcloud.js';
import { startMetricsServer } from '../../../src/utils/metrics.js';
import { getArgs, withWarpRouteIdRequired } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

import {
  metricsRegister,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import { WarpRouteBalance, XERC20Limit } from './types.js';
import { logger, tryFn } from './utils.js';

async function main() {
  const { checkFrequency, environment, warpRouteId } =
    await withWarpRouteIdRequired(getArgs())
      .describe('checkFrequency', 'frequency to check balances in ms')
      .demandOption('checkFrequency')
      .alias('v', 'checkFrequency') // v as in Greek letter nu
      .number('checkFrequency')
      .parse();

  startMetricsServer(metricsRegister);

  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry();
  const chainMetadata = await registry.getMetadata();

  // The Sealevel warp adapters require the Mailbox address, so we
  // get router configs (that include the Mailbox address) for all chains
  // and merge them with the chain metadata.
  const routerConfig = await getRouterConfigsForAllVms(
    envConfig,
    await envConfig.getMultiProvider(),
  );
  const mailboxes = objMap(routerConfig, (_chain, config: RouterConfig) => ({
    mailbox: config.mailbox,
  }));
  const multiProtocolProvider = new MultiProtocolProvider(
    objMerge(chainMetadata, mailboxes),
  );
  const warpCoreConfig = getWarpCoreConfig(warpRouteId);
  const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);

  await pollAndUpdateWarpRouteMetrics(checkFrequency, warpCore, chainMetadata);
}

// Indefinitely loops, updating warp route metrics at the specified frequency.
async function pollAndUpdateWarpRouteMetrics(
  checkFrequency: number,
  warpCore: WarpCore,
  chainMetadata: ChainMap<ChainMetadata>,
) {
  const tokenPriceGetter = new CoinGeckoTokenPriceGetter({
    chainMetadata,
    apiKey: await getCoinGeckoApiKey(),
  });

  setInterval(async () => {
    await tryFn(async () => {
      await Promise.all(
        warpCore.tokens.map((token) =>
          updateTokenMetrics(warpCore, token, tokenPriceGetter),
        ),
      );
    }, 'Updating warp route metrics');
  }, checkFrequency);
}

// Updates the metrics for a single token in a warp route.
async function updateTokenMetrics(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
) {
  const promises = [
    tryFn(async () => {
      const balanceInfo = await getTokenBridgedBalance(
        warpCore,
        token,
        tokenPriceGetter,
      );
      if (!balanceInfo) {
        return;
      }
      updateTokenBalanceMetrics(warpCore, token, balanceInfo);
    }, 'Getting bridged balance and value'),
  ];

  if (token.isXerc20()) {
    promises.push(
      tryFn(async () => {
        const limits = await getXERC20Limits(warpCore, token);
        updateXERC20LimitsMetrics(token, limits);
      }, 'Getting xERC20 limits'),
    );
  }

  await Promise.all(promises);
}

// Gets the bridged balance and value of a token in a warp route.
async function getTokenBridgedBalance(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<WarpRouteBalance | undefined> {
  if (!token.isHypToken()) {
    logger.warn('Cannot get bridged balance for a non-Hyperlane token', token);
    return undefined;
  }

  const adapter = token.getHypAdapter(warpCore.multiProvider);
  const bridgedSupply = await adapter.getBridgedSupply();
  if (!bridgedSupply) {
    logger.warn('Bridged supply not found for token', token);
    return undefined;
  }
  const balance = token.amount(bridgedSupply).getDecimalFormattedAmount();

  let tokenPrice;
  // Only record value for collateralized and xERC20 lockbox tokens.
  if (
    token.isCollateralized() ||
    token.standard === TokenStandard.EvmHypXERC20Lockbox
  ) {
    tokenPrice = await tryGetTokenPrice(token, tokenPriceGetter);
  }

  return {
    balance,
    valueUSD: tokenPrice ? balance * tokenPrice : undefined,
  };
}

async function getXERC20Limits(
  warpCore: WarpCore,
  token: Token,
): Promise<XERC20Limit> {
  if (token.protocol !== ProtocolType.Ethereum) {
    throw new Error(`Unsupported XERC20 protocol type ${token.protocol}`);
  }

  if (token.standard === TokenStandard.EvmHypXERC20) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20Adapter;
    return getXERC20Limit(token, adapter);
  } else if (token.standard === TokenStandard.EvmHypXERC20Lockbox) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20LockboxAdapter;
    return getXERC20Limit(token, adapter);
  }
  throw new Error(`Unsupported XERC20 token standard ${token.standard}`);
}

async function getXERC20Limit(
  token: Token,
  xerc20: IHypXERC20Adapter<PopulatedTransaction>,
): Promise<XERC20Limit> {
  const formatBigInt = (num: bigint) => {
    return token.amount(num).getDecimalFormattedAmount();
  };

  const [mintCurrent, mintMax, burnCurrent, burnMax] = await Promise.all([
    xerc20.getMintLimit(),
    xerc20.getMintMaxLimit(),
    xerc20.getBurnLimit(),
    xerc20.getBurnMaxLimit(),
  ]);

  return {
    mint: formatBigInt(mintCurrent),
    mintMax: formatBigInt(mintMax),
    burn: formatBigInt(burnCurrent),
    burnMax: formatBigInt(burnMax),
  };
}

// Tries to get the price of a token from CoinGecko. Returns undefined if there's no
// CoinGecko ID for the token.
async function tryGetTokenPrice(
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  // We only get a price if the token defines a CoinGecko ID.
  // This way we can ignore values of certain types of collateralized warp routes,
  // e.g. Native warp routes on rollups that have been pre-funded.
  let coinGeckoId = token.coinGeckoId;

  if (!coinGeckoId) {
    logger.warn('CoinGecko ID missing for token', token.symbol);
    return undefined;
  }

  return getCoingeckoPrice(tokenPriceGetter, coinGeckoId);
}

async function getCoingeckoPrice(
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  coingeckoId: string,
): Promise<number | undefined> {
  const prices = await tokenPriceGetter.getTokenPriceByIds([coingeckoId]);
  if (!prices) return undefined;
  return prices[0];
}

async function getCoinGeckoApiKey(): Promise<string | undefined> {
  const environment: DeployEnvironment = 'mainnet3';
  let apiKey: string | undefined;
  try {
    apiKey = (await fetchGCPSecret(
      `${environment}-coingecko-api-key`,
      false,
    )) as string;
  } catch (e) {
    logger.error(
      'Error fetching CoinGecko API key, proceeding with public tier',
      e,
    );
  }

  return apiKey;
}

main()
  .then(logger.info)
  .catch((err) => {
    logger.error('Error in main', err);
    process.exit(1);
  });
