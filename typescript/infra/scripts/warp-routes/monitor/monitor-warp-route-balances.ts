import { PopulatedTransaction } from 'ethers';

import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  IHypXERC20Adapter,
  MultiProtocolProvider,
  SealevelHypTokenAdapter,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap, objMerge, sleep } from '@hyperlane-xyz/utils';

import { getWarpCoreConfig } from '../../../config/registry.js';
import { DeployEnvironment } from '../../../src/config/environment.js';
import { fetchGCPSecret } from '../../../src/utils/gcloud.js';
import { startMetricsServer } from '../../../src/utils/metrics.js';
import {
  getArgs,
  getWarpRouteIdInteractive,
  withWarpRouteId,
} from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

import {
  metricsRegister,
  updateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import { NativeWalletBalance, WarpRouteBalance, XERC20Limit } from './types.js';
import { logger, tryFn } from './utils.js';

async function main() {
  const {
    checkFrequency,
    environment,
    warpRouteId: warpRouteIdArg,
  } = await withWarpRouteId(getArgs())
    .describe('checkFrequency', 'frequency to check balances in ms')
    .demandOption('checkFrequency')
    .alias('v', 'checkFrequency') // v as in Greek letter nu
    .number('checkFrequency')
    .parse();

  const warpRouteId = warpRouteIdArg || (await getWarpRouteIdInteractive());

  startMetricsServer(metricsRegister);

  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry();
  const chainMetadata = await registry.getMetadata();
  const chainAddresses = await registry.getAddresses();

  // The Sealevel warp adapters require the Mailbox address, so we
  // get mailboxes for all chains and merge them with the chain metadata.
  const mailboxes = objMap(chainAddresses, (_, { mailbox }) => ({
    mailbox,
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
  const collateralTokenSymbol = getWarpRouteCollateralTokenSymbol(warpCore);

  while (true) {
    await tryFn(async () => {
      await Promise.all(
        warpCore.tokens.map((token) =>
          updateTokenMetrics(
            warpCore,
            token,
            tokenPriceGetter,
            collateralTokenSymbol,
          ),
        ),
      );
    }, 'Updating warp route metrics');
    await sleep(checkFrequency);
  }
}

// Updates the metrics for a single token in a warp route.
async function updateTokenMetrics(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  collateralTokenSymbol: string,
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
      updateTokenBalanceMetrics(
        warpCore,
        token,
        balanceInfo,
        collateralTokenSymbol,
      );
    }, 'Getting bridged balance and value'),
  ];

  // For Sealevel collateral and synthetic tokens, there is an
  // "Associated Token Account" (ATA) rent payer that has a balance
  // that's used to pay for rent for the accounts that store user balances.
  // This is necessary if the recipient has never received any tokens before.
  if (token.protocol === ProtocolType.Sealevel && !token.isNative()) {
    promises.push(
      tryFn(async () => {
        const balance = await getSealevelAtaPayerBalance(warpCore, token);
        updateNativeWalletBalanceMetrics(balance);
      }, 'Getting ATA payer balance'),
    );
  }

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
  if (bridgedSupply === undefined) {
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

// Gets the native balance of the ATA payer, which is used to pay for
// rent when delivering tokens to an account that previously didn't
// have a balance.
// Only intended for Collateral or Synthetic Sealevel tokens.
async function getSealevelAtaPayerBalance(
  warpCore: WarpCore,
  token: Token,
): Promise<NativeWalletBalance> {
  if (token.protocol !== ProtocolType.Sealevel || token.isNative()) {
    throw new Error(
      `Unsupported ATA payer protocol type ${token.protocol} or standard ${token.standard}`,
    );
  }
  const adapter = token.getHypAdapter(
    warpCore.multiProvider,
  ) as SealevelHypTokenAdapter;

  const ataPayer = adapter.deriveAtaPayerAccount().toString();
  const nativeToken = Token.FromChainMetadataNativeToken(
    warpCore.multiProvider.getChainMetadata(token.chainName),
  );
  const ataPayerBalance = await nativeToken.getBalance(
    warpCore.multiProvider,
    ataPayer,
  );

  const warpRouteId = createWarpRouteConfigId(
    token.symbol,
    warpCore.getTokenChains(),
  );
  return {
    chain: token.chainName,
    walletAddress: ataPayer.toString(),
    walletName: `${warpRouteId}/ata-payer`,
    balance: ataPayerBalance.getDecimalFormattedAmount(),
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
  const coinGeckoId = token.coinGeckoId;

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

function getWarpRouteCollateralTokenSymbol(warpCore: WarpCore): string {
  // We need to have a deterministic way to determine the symbol of the warp route
  // as its used to identify the warp route in metrics. This method should support routes where:
  // - All tokens have the same symbol, token standards can be all collateral, all synthetic or a mix
  // - All tokens have different symbol, but there is a collateral token to break the tie, where there are multiple collateral tokens, alphabetically first is chosen
  // - All tokens have different symbol, but there is no collateral token to break the tie, pick the alphabetically first symbol

  // Get all unique symbols from the tokens array
  const uniqueSymbols = new Set(warpCore.tokens.map((token) => token.symbol));

  // If all tokens have the same symbol, return that symbol
  if (uniqueSymbols.size === 1) {
    return warpCore.tokens[0].symbol;
  }

  // Find all collateralized tokens
  const collateralTokens = warpCore.tokens.filter(
    (token) =>
      token.isCollateralized() ||
      token.standard === TokenStandard.EvmHypXERC20Lockbox,
  );

  if (collateralTokens.length === 0) {
    // If there are no collateralized tokens, return the alphabetically first symbol
    return [...uniqueSymbols].sort()[0];
  }

  // if there is a single unique collateral symbol return it or
  // ifthere are multiple, return the alphabetically first symbol
  const collateralSymbols = collateralTokens.map((token) => token.symbol);
  const uniqueCollateralSymbols = [...new Set(collateralSymbols)];

  return uniqueCollateralSymbols.sort()[0];
}

main().catch((err) => {
  logger.error('Error in main:', err);
  process.exit(1);
});
