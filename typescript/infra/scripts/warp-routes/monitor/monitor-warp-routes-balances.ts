import { PopulatedTransaction } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  IHypXERC20Adapter,
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
  WarpCoreConfig,
  WarpCoreConfigSchema,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMerge } from '@hyperlane-xyz/utils';

import {
  DeployEnvironment,
  getRouterConfigsForAllVms,
} from '../../../src/config/environment.js';
import { fetchGCPSecret } from '../../../src/utils/gcloud.js';
import { startMetricsServer } from '../../../src/utils/metrics.js';
import { readYaml } from '../../../src/utils/utils.js';
import { getArgs } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

import {
  metricsRegister,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import { WarpRouteBalance, XERC20Limit } from './types.js';
import { gracefullyHandleError, logger } from './utils.js';

function readWarpCoreConfig(filePath: string): WarpCoreConfig {
  const config = readYaml(filePath);
  if (!config) throw new Error(`No warp core config found at ${filePath}`);
  const result = WarpCoreConfigSchema.safeParse(config);
  if (!result.success) {
    const errorMessages = result.error.issues.map(
      (issue: any) => `${issue.path} => ${issue.message}`,
    );
    throw new Error(`Invalid warp core config:\n ${errorMessages.join('\n')}`);
  }
  return result.data;
}

async function main() {
  const { checkFrequency, filePath, environment } = await getArgs()
    .describe('checkFrequency', 'frequency to check balances in ms')
    .demandOption('checkFrequency')
    .alias('v', 'checkFrequency') // v as in Greek letter nu
    .number('checkFrequency')
    .alias('f', 'filePath')
    .describe(
      'filePath',
      'indicate the filepatch to the warp route yaml file relative to typescript/infra',
    )
    .demandOption('filePath')
    .string('filePath')
    .parse();

  startMetricsServer(metricsRegister);

  const warpCoreConfig = readWarpCoreConfig(filePath);

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
  const multiProtocolProvider = new MultiProtocolProvider(
    objMerge(chainMetadata, routerConfig),
  );
  const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);

  await pollAndUpdateWarpRouteMetrics(checkFrequency, warpCore, chainMetadata);
}

// Indefinitely loops, updating warp route metrics at the specified frequency.
async function pollAndUpdateWarpRouteMetrics(
  checkFrequency: number,
  warpCore: WarpCore,
  chainMetadata: ChainMap<ChainMetadata>,
) {
  const tokenPriceGetter = CoinGeckoTokenPriceGetter.withDefaultCoinGecko(
    chainMetadata,
    await getCoinGeckoApiKey(),
  );

  setInterval(async () => {
    // Is this needed? maybe
    await gracefullyHandleError(async () => {
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
    gracefullyHandleError(async () => {
      const balanceInfo = await getTokenBridgedBalance(
        warpCore,
        token,
        tokenPriceGetter,
      );
      updateTokenBalanceMetrics(warpCore, token, balanceInfo);
    }, 'Getting bridged balance and value'),
  ];

  if (token.isXerc20()) {
    promises.push(
      gracefullyHandleError(async () => {
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
): Promise<WarpRouteBalance> {
  const bridgedSupply = await token.getBridgedSupply(warpCore.multiProvider);
  if (!bridgedSupply) {
    logger.warn('Bridged supply not found for token', token);
    return { balance: 0 };
  }

  const tokenPrice = await tryGetTokenPrice(warpCore, token, tokenPriceGetter);
  const balance = bridgedSupply.getDecimalFormattedAmount();

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
  const formatBigint = (num: bigint) => {
    return token.amount(num).getDecimalFormattedAmount();
  };

  const [mintCurrent, mintMax, burnCurrent, burnMax] = await Promise.all([
    xerc20.getMintLimit(),
    xerc20.getMintMaxLimit(),
    xerc20.getBurnLimit(),
    xerc20.getBurnMaxLimit(),
  ]);

  return {
    tokenName: token.name,
    mint: formatBigint(mintCurrent),
    mintMax: formatBigint(mintMax),
    burn: formatBigint(burnCurrent),
    burnMax: formatBigint(burnMax),
  };
}

// Tries to get the price of a token from CoinGecko. Returns undefined if there's no
// CoinGecko ID for the token.
async function tryGetTokenPrice(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  // We assume all tokens in the warp route are the same token, so just find the first one.
  let coinGeckoId = warpCore.tokens.find(
    (t) => t.coinGeckoId !== undefined,
  )?.coinGeckoId;

  // If the token is a native token, we may be able to get the CoinGecko ID from the chain metadata.
  if (!coinGeckoId && token.isNative()) {
    const chainMetadata = warpCore.multiProvider.getChainMetadata(
      token.chainName,
    );
    // To defend against Cosmos, which can have multiple types of native tokens,
    // we only use the gas currency CoinGecko ID if it matches the token symbol.
    if (chainMetadata.nativeToken?.symbol === token.symbol) {
      coinGeckoId = chainMetadata.gasCurrencyCoinGeckoId;
    }
  }

  if (!coinGeckoId) {
    logger.warn('CoinGecko ID missing for token', token);
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

main().then(logger.info).catch(logger.error);
