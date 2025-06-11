import { Contract, PopulatedTransaction } from 'ethers';

import { IXERC20VS__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  EvmHypXERC20Adapter,
  EvmHypXERC20LockboxAdapter,
  EvmTokenAdapter,
  IHypXERC20Adapter,
  MultiProtocolProvider,
  SealevelHypTokenAdapter,
  Token,
  TokenStandard,
  TokenType,
  WarpCore,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  objMap,
  objMerge,
  sleep,
} from '@hyperlane-xyz/utils';

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
  updateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import { NativeWalletBalance, WarpRouteBalance, XERC20Limit } from './types.js';
import { logger, tryFn } from './utils.js';

interface XERC20Info {
  limits: XERC20Limit;
  xERC20Address: Address;
}

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
  const warpDeployConfig = await registry.getWarpDeployConfig(warpRouteId);

  await pollAndUpdateWarpRouteMetrics(
    checkFrequency,
    warpCore,
    warpDeployConfig,
    chainMetadata,
    warpRouteId,
  );
}

// Indefinitely loops, updating warp route metrics at the specified frequency.
async function pollAndUpdateWarpRouteMetrics(
  checkFrequency: number,
  warpCore: WarpCore,
  warpDeployConfig: WarpRouteDeployConfig | null,
  chainMetadata: ChainMap<ChainMetadata>,
  warpRouteId: string,
) {
  const tokenPriceGetter = new CoinGeckoTokenPriceGetter({
    chainMetadata,
    apiKey: await getCoinGeckoApiKey(),
  });

  while (true) {
    await tryFn(async () => {
      await Promise.all(
        warpCore.tokens.map((token) =>
          updateTokenMetrics(
            warpCore,
            warpDeployConfig,
            token,
            tokenPriceGetter,
            warpRouteId,
          ),
        ),
      );
    }, 'Updating warp route metrics');
    await sleep(checkFrequency);
  }
}

/**
 * Updates all relevant metrics for a single token within a Warp route.
 *
 * Depending on the token type, this function updates bridged token balances, xERC20 mint/burn limits, Sealevel ATA payer balances, and managed lockbox balances and limits. For xERC20 tokens, it also processes any associated extra lockboxes defined in the deployment configuration.
 *
 * @param warpCore - The WarpCore instance for interacting with the Warp route.
 * @param warpDeployConfig - The deployment configuration for the Warp route, or null if unavailable.
 * @param token - The token for which metrics are being updated.
 * @param tokenPriceGetter - Utility for fetching token prices from CoinGecko.
 * @param warpRouteId - The identifier for the Warp route.
 *
 * @remark
 * If the deployment configuration is missing or the token type does not match the expected xERC20 types, extra lockbox metrics are not updated for that token.
 */
async function updateTokenMetrics(
  warpCore: WarpCore,
  warpDeployConfig: WarpRouteDeployConfig | null,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  warpRouteId: string,
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
      updateTokenBalanceMetrics(warpCore, token, balanceInfo, warpRouteId);
    }, 'Getting bridged balance and value'),
  ];

  // For Sealevel collateral and synthetic tokens, there is an
  // "Associated Token Account" (ATA) rent payer that has a balance
  // that's used to pay for rent for the accounts that store user balances.
  // This is necessary if the recipient has never received any tokens before.
  if (token.protocol === ProtocolType.Sealevel && !token.isNative()) {
    promises.push(
      tryFn(async () => {
        const balance = await getSealevelAtaPayerBalance(
          warpCore,
          token,
          warpRouteId,
        );
        updateNativeWalletBalanceMetrics(balance);
      }, 'Getting ATA payer balance'),
    );
  }

  if (token.isXerc20()) {
    promises.push(
      tryFn(async () => {
        const { limits, xERC20Address } = await getXERC20Info(warpCore, token);
        const routerAddress = token.addressOrDenom;
        updateXERC20LimitsMetrics(
          token,
          limits,
          routerAddress,
          token.standard,
          xERC20Address,
        );
      }, 'Getting xERC20 limits'),
    );

    if (!warpDeployConfig) {
      logger.warn(
        `Failed to read warp deploy config for token ${token.symbol}` +
          ` on chain ${token.chainName} skipping extra lockboxes`,
      );
      return;
    }

    // If the current token is an xERC20, we need to check if there are any extra lockboxes
    const currentTokenDeployConfig = warpDeployConfig[token.chainName];
    if (
      currentTokenDeployConfig.type !== TokenType.XERC20 &&
      currentTokenDeployConfig.type !== TokenType.XERC20Lockbox
    ) {
      logger.error(
        `Token is xERC20 but token deploy config is ${currentTokenDeployConfig.type} ` +
          `for token ${token.symbol} on chain ${token.chainName}`,
      );
      return;
    }

    const extraLockboxes = currentTokenDeployConfig.xERC20?.extraBridges ?? [];

    for (const lockbox of extraLockboxes) {
      promises.push(
        tryFn(async () => {
          const { limits, xERC20Address } = await getExtraLockboxInfo(
            token,
            warpCore.multiProvider,
            lockbox.lockbox,
          );

          updateXERC20LimitsMetrics(
            token,
            limits,
            lockbox.lockbox,
            'EvmManagedLockbox',
            xERC20Address,
          );
        }, 'Getting extra lockbox limits'),
        tryFn(async () => {
          const balance = await getExtraLockboxBalance(
            token,
            warpCore.multiProvider,
            tokenPriceGetter,
            lockbox.lockbox,
          );

          if (balance) {
            const { tokenName, tokenAddress } =
              await getManagedLockBoxCollateralInfo(
                token,
                warpCore.multiProvider,
                lockbox.lockbox,
              );

            updateManagedLockboxBalanceMetrics(
              warpCore,
              token.chainName,
              tokenName,
              tokenAddress,
              lockbox.lockbox,
              balance,
              warpRouteId,
            );
          }
        }, `Updating extra lockbox balance for contract at "${lockbox.lockbox}" on chain ${token.chainName}`),
      );
    }
  }

  await Promise.all(promises);
}

/**
 * Retrieves the bridged token balance and its USD value for a Hyperlane token in a Warp route.
 *
 * For collateralized and xERC20 lockbox tokens, also fetches the token price and computes the USD value.
 *
 * @returns An object containing the bridged balance, USD value (if available), and token address, or `undefined` if unsupported or unavailable.
 */
async function getTokenBridgedBalance(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<WarpRouteBalance | undefined> {
  if (!token.isHypToken()) {
    logger.warn(
      `No support for getting bridged balance for a non-Hyperlane token ${token.symbol}`,
    );
    return undefined;
  }

  const adapter = token.getHypAdapter(warpCore.multiProvider);
  let tokenAddress = token.collateralAddressOrDenom ?? token.addressOrDenom;
  const bridgedSupply = await adapter.getBridgedSupply();
  if (bridgedSupply === undefined) {
    logger.warn(`Failed to get bridged supply for token ${token.symbol}`);
    return undefined;
  }
  const balance = token.amount(bridgedSupply).getDecimalFormattedAmount();

  let tokenPrice;
  // Only record value for collateralized and xERC20 lockbox tokens.
  if (
    token.isCollateralized() ||
    token.standard === TokenStandard.EvmHypXERC20Lockbox ||
    token.standard === TokenStandard.EvmHypVSXERC20Lockbox
  ) {
    tokenPrice = await tryGetTokenPrice(token, tokenPriceGetter);
  }

  if (
    token.standard === TokenStandard.EvmHypXERC20Lockbox ||
    token.standard === TokenStandard.EvmHypVSXERC20Lockbox
  ) {
    tokenAddress = (await (adapter as EvmHypXERC20LockboxAdapter).getXERC20())
      .address;
  }

  return {
    balance,
    valueUSD: tokenPrice ? balance * tokenPrice : undefined,
    tokenAddress,
  };
}

async function getManagedLockBoxCollateralInfo(
  warpToken: Token,
  multiProtocolProvider: MultiProtocolProvider,
  lockBoxAddress: Address,
): Promise<{ tokenName: string; tokenAddress: Address }> {
  const lockBoxInstance = await getManagedLockBox(
    warpToken,
    multiProtocolProvider,
    lockBoxAddress,
  );

  const collateralTokenAddress = await lockBoxInstance.ERC20();
  const collateralTokenAdapter = new EvmTokenAdapter(
    warpToken.chainName,
    multiProtocolProvider,
    {
      token: collateralTokenAddress,
    },
  );

  const { name } = await collateralTokenAdapter.getMetadata();

  return {
    tokenName: name,
    tokenAddress: collateralTokenAddress,
  };
}

function formatBigInt(warpToken: Token, num: bigint): number {
  return warpToken.amount(num).getDecimalFormattedAmount();
}

// Gets the native balance of the ATA payer, which is used to pay for
// rent when delivering tokens to an account that previously didn't
// have a balance.
// Only intended for Collateral or Synthetic Sealevel tokens.
async function getSealevelAtaPayerBalance(
  warpCore: WarpCore,
  token: Token,
  warpRouteId: string,
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
  return {
    chain: token.chainName,
    walletAddress: ataPayer.toString(),
    walletName: `${warpRouteId}/ata-payer`,
    balance: ataPayerBalance.getDecimalFormattedAmount(),
  };
}

async function getXERC20Info(
  warpCore: WarpCore,
  token: Token,
): Promise<XERC20Info> {
  if (token.protocol !== ProtocolType.Ethereum) {
    throw new Error(`Unsupported XERC20 protocol type ${token.protocol}`);
  }

  if (
    token.standard === TokenStandard.EvmHypXERC20 ||
    token.standard === TokenStandard.EvmHypVSXERC20
  ) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20Adapter;
    return {
      limits: await getXERC20Limit(token, adapter),
      xERC20Address: (await adapter.getXERC20()).address,
    };
  } else if (
    token.standard === TokenStandard.EvmHypXERC20Lockbox ||
    token.standard === TokenStandard.EvmHypVSXERC20Lockbox
  ) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20LockboxAdapter;
    return {
      limits: await getXERC20Limit(token, adapter),
      xERC20Address: (await adapter.getXERC20()).address,
    };
  }
  throw new Error(`Unsupported XERC20 token standard ${token.standard}`);
}

async function getXERC20Limit(
  token: Token,
  xerc20: IHypXERC20Adapter<PopulatedTransaction>,
): Promise<XERC20Limit> {
  const [mintCurrent, mintMax, burnCurrent, burnMax] = await Promise.all([
    xerc20.getMintLimit(),
    xerc20.getMintMaxLimit(),
    xerc20.getBurnLimit(),
    xerc20.getBurnMaxLimit(),
  ]);

  return {
    mint: formatBigInt(token, mintCurrent),
    mintMax: formatBigInt(token, mintMax),
    burn: formatBigInt(token, burnCurrent),
    burnMax: formatBigInt(token, burnMax),
  };
}

const managedLockBoxMinimalABI = [
  'function XERC20() view returns (address)',
  'function ERC20() view returns (address)',
] as const;

async function getExtraLockboxInfo(
  warpToken: Token,
  multiProtocolProvider: MultiProtocolProvider,
  lockboxAddress: Address,
): Promise<XERC20Info> {
  const currentChainProvider = multiProtocolProvider.getEthersV5Provider(
    warpToken.chainName,
  );
  const lockboxInstance = await getManagedLockBox(
    warpToken,
    multiProtocolProvider,
    lockboxAddress,
  );

  const xERC20Address = await lockboxInstance.XERC20();
  const vsXERC20Address = IXERC20VS__factory.connect(
    xERC20Address,
    currentChainProvider,
  ); // todo use adapter

  const [mintMax, burnMax, mint, burn] = await Promise.all([
    vsXERC20Address.mintingMaxLimitOf(lockboxAddress),
    vsXERC20Address.burningMaxLimitOf(lockboxAddress),
    vsXERC20Address.mintingCurrentLimitOf(lockboxAddress),
    vsXERC20Address.burningCurrentLimitOf(lockboxAddress),
  ]);

  return {
    limits: {
      burn: formatBigInt(warpToken, burn.toBigInt()),
      burnMax: formatBigInt(warpToken, burnMax.toBigInt()),
      mint: formatBigInt(warpToken, mint.toBigInt()),
      mintMax: formatBigInt(warpToken, mintMax.toBigInt()),
    },
    xERC20Address,
  };
}

async function getManagedLockBox(
  warpToken: Token,
  multiProtocolProvider: MultiProtocolProvider,
  lockboxAddress: Address,
): Promise<Contract> {
  const chainName = warpToken.chainName;
  const provider = multiProtocolProvider.getEthersV5Provider(chainName);
  return new Contract(lockboxAddress, managedLockBoxMinimalABI, provider);
}

/**
 * Retrieves the ERC20 token balance and USD value for a managed lockbox associated with an xERC20 Warp token.
 *
 * @param warpToken - The xERC20 Warp token whose lockbox balance is being queried.
 * @param lockboxAddress - The address of the managed lockbox contract.
 * @returns An object containing the lockbox's ERC20 token balance, its USD value if available, and the ERC20 token address, or undefined if the balance cannot be retrieved or the token is not xERC20.
 */
async function getExtraLockboxBalance(
  warpToken: Token,
  multiProtocolProvider: MultiProtocolProvider,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
  lockboxAddress: Address,
): Promise<WarpRouteBalance | undefined> {
  if (!warpToken.isXerc20()) {
    return;
  }

  const lockboxInstance = await getManagedLockBox(
    warpToken,
    multiProtocolProvider,
    lockboxAddress,
  );

  const erc20TokenAddress = await lockboxInstance.ERC20();
  const erc20tokenAdapter = new EvmTokenAdapter(
    warpToken.chainName,
    multiProtocolProvider,
    {
      token: erc20TokenAddress,
    },
  );

  let balance;
  try {
    balance = await erc20tokenAdapter.getBalance(lockboxAddress);
  } catch (err) {
    logger.error(
      err,
      `Failed to get balance for contract at "${lockboxAddress}"` +
        ` on chain ${warpToken.chainName} on token ${erc20TokenAddress}`,
    );
    return;
  }

  const tokenPrice = await tryGetTokenPrice(warpToken, tokenPriceGetter);

  const balanceNumber = formatBigInt(warpToken, balance);

  return {
    balance: balanceNumber,
    valueUSD: tokenPrice ? balanceNumber * tokenPrice : undefined,
    tokenAddress: erc20TokenAddress,
  };
}

// Tries to get the price of a token from CoinGecko. Returns undefined if there's no
/**
 * Attempts to retrieve the current price of a token using its CoinGecko ID.
 *
 * @param token - The token for which to fetch the price.
 * @param tokenPriceGetter - The CoinGecko price getter instance.
 * @returns The token price if available, or undefined if the token lacks a CoinGecko ID.
 *
 * @remark If the token does not have a CoinGecko ID, a warning is logged and undefined is returned.
 */
async function tryGetTokenPrice(
  token: Token,
  tokenPriceGetter: CoinGeckoTokenPriceGetter,
): Promise<number | undefined> {
  // We only get a price if the token defines a CoinGecko ID.
  // This way we can ignore values of certain types of collateralized warp routes,
  // e.g. Native warp routes on rollups that have been pre-funded.
  const coinGeckoId = token.coinGeckoId;

  if (!coinGeckoId) {
    logger.warn(`Missing CoinGecko ID for token ${token.symbol}`);
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

/**
 * Retrieves the CoinGecko API key from Google Cloud Platform secrets for the 'mainnet3' environment.
 *
 * @returns The CoinGecko API key if available, or undefined if retrieval fails.
 *
 * @remark If the API key cannot be fetched, the function logs an error and returns undefined, allowing the application to proceed using the public CoinGecko API tier.
 */
async function getCoinGeckoApiKey(): Promise<string | undefined> {
  const environment: DeployEnvironment = 'mainnet3';
  let apiKey: string | undefined;
  try {
    apiKey = (await fetchGCPSecret(
      `${environment}-coingecko-api-key`,
      false,
    )) as string;
  } catch (err) {
    logger.error(
      err,
      'Failed to fetch CoinGecko API key, proceeding with public tier',
    );
  }

  return apiKey;
}

/**
 * Determines a deterministic symbol for a Warp route based on its tokens.
 *
 * If all tokens share the same symbol, returns that symbol. If there are collateral tokens, returns the alphabetically first collateral token symbol. If no collateral tokens exist, returns the alphabetically first symbol among all tokens.
 *
 * @returns The selected symbol representing the Warp route.
 */
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
      token.standard === TokenStandard.EvmHypXERC20Lockbox ||
      token.standard === TokenStandard.EvmHypVSXERC20Lockbox,
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
  logger.error(err);
  process.exit(1);
});
