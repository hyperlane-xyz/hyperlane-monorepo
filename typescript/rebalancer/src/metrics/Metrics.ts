import { type Logger } from 'pino';

import {
  type TokenPriceGetter,
  getExtraLockboxBalance,
  getExtraLockboxInfo,
  getManagedLockBoxCollateralInfo,
  getSealevelAtaPayerBalance,
  getTokenBridgedBalance,
  getXERC20Info,
  startMetricsServer,
  tryFn,
} from '@hyperlane-xyz/metrics';
import {
  Token,
  type TokenAmount,
  TokenStandard,
  TokenType,
  type WarpCore,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { type IMetrics } from '../interfaces/IMetrics.js';
import { type MonitorEvent } from '../interfaces/IMonitor.js';
import { type RebalancingRoute } from '../interfaces/IStrategy.js';

import { type PriceGetter } from './PriceGetter.js';
import {
  metricsRegister,
  rebalancerExecutionAmount,
  rebalancerExecutionTotal,
  rebalancerPollingErrorsTotal,
  updateManagedLockboxBalanceMetrics,
  updateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './scripts/metrics.js';

export class Metrics implements IMetrics {
  private readonly logger: Logger;
  private readonly priceGetter: TokenPriceGetter;

  constructor(
    private readonly tokenPriceGetter: PriceGetter,
    private readonly warpDeployConfig: WarpRouteDeployConfig | null,
    private readonly warpCore: WarpCore,
    private readonly warpRouteId: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ class: Metrics.name });
    startMetricsServer(metricsRegister);

    // Wrap PriceGetter to match TokenPriceGetter interface
    this.priceGetter = {
      tryGetTokenPrice: async (token: Token) => {
        return this.tokenPriceGetter.tryGetTokenPrice(token);
      },
    };
  }

  recordRebalancerSuccess() {
    rebalancerExecutionTotal
      .labels({ warp_route_id: this.warpRouteId, succeeded: 'true' })
      .inc();
  }

  recordRebalanceAmount(
    route: RebalancingRoute,
    originTokenAmount: TokenAmount,
  ) {
    rebalancerExecutionAmount
      .labels({
        warp_route_id: this.warpRouteId,
        origin: route.origin,
        destination: route.destination,
        token: originTokenAmount.token.symbol,
      })
      .inc(originTokenAmount.getDecimalFormattedAmount());
  }

  recordRebalancerFailure() {
    rebalancerExecutionTotal
      .labels({ warp_route_id: this.warpRouteId, succeeded: 'false' })
      .inc();
  }

  recordPollingError() {
    rebalancerPollingErrorsTotal
      .labels({ warp_route_id: this.warpRouteId })
      .inc();
  }

  async processToken({
    token,
    bridgedSupply,
  }: MonitorEvent['tokensInfo'][number]) {
    await tryFn(
      async () => {
        await this.updateTokenMetrics(token, bridgedSupply);
      },
      'Updating warp route metrics',
      this.logger,
    );
  }

  // Updates the metrics for a single token in a warp route.
  private async updateTokenMetrics(
    token: Token,
    bridgedSupply?: bigint,
  ): Promise<void> {
    const promises = [
      tryFn(
        async () => {
          const balanceInfo = await getTokenBridgedBalance(
            this.warpCore,
            token,
            this.priceGetter,
            this.logger,
            bridgedSupply,
          );

          if (!balanceInfo) {
            return;
          }

          updateTokenBalanceMetrics(
            this.warpCore,
            token,
            balanceInfo,
            this.warpRouteId,
            this.logger,
          );
        },
        'Getting bridged balance and value',
        this.logger,
      ),
    ];

    // For Sealevel collateral and synthetic tokens, there is an
    // "Associated Token Account" (ATA) rent payer that has a balance
    // that's used to pay for rent for the accounts that store user balances.
    // This is necessary if the recipient has never received any tokens before.
    if (token.protocol === ProtocolType.Sealevel && !token.isNative()) {
      promises.push(
        tryFn(
          async () => {
            const balance = await getSealevelAtaPayerBalance(
              this.warpCore,
              token,
              this.warpRouteId,
            );

            updateNativeWalletBalanceMetrics(balance, this.logger);
          },
          'Getting ATA payer balance',
          this.logger,
        ),
      );
    }

    if (token.isXerc20()) {
      promises.push(
        tryFn(
          async () => {
            const { limits, xERC20Address } = await getXERC20Info(
              this.warpCore,
              token,
            );
            const routerAddress = token.addressOrDenom;

            updateXERC20LimitsMetrics(
              token,
              limits,
              routerAddress,
              token.standard,
              xERC20Address,
              this.logger,
            );
          },
          'Getting xERC20 limits',
          this.logger,
        ),
      );

      if (!this.warpDeployConfig) {
        this.logger.warn(
          {
            tokenSymbol: token.symbol,
            chain: token.chainName,
          },
          "Can't read warp deploy config, skipping extra lockboxes",
        );
        return;
      }

      // If the current token is an xERC20, we need to check if there are any extra lockboxes
      const currentTokenDeployConfig = this.warpDeployConfig[token.chainName];

      if (
        currentTokenDeployConfig.type !== TokenType.XERC20 &&
        currentTokenDeployConfig.type !== TokenType.XERC20Lockbox
      ) {
        this.logger.error(
          {
            tokenSymbol: token.symbol,
            chain: token.chainName,
            expectedType: [TokenType.XERC20, TokenType.XERC20Lockbox],
            actualType: currentTokenDeployConfig.type,
          },
          'Token type mismatch in deploy config for xERC20 token',
        );
        return;
      }

      const extraLockboxes =
        currentTokenDeployConfig.xERC20?.extraBridges ?? [];

      for (const lockbox of extraLockboxes) {
        promises.push(
          tryFn(
            async () => {
              const { limits, xERC20Address } = await getExtraLockboxInfo(
                this.warpCore.multiProvider,
                token,
                lockbox.lockbox,
              );

              updateXERC20LimitsMetrics(
                token,
                limits,
                lockbox.lockbox,
                'EvmManagedLockbox',
                xERC20Address,
                this.logger,
              );
            },
            'Getting extra lockbox limits',
            this.logger,
          ),
          tryFn(
            async () => {
              const balance = await getExtraLockboxBalance(
                this.warpCore.multiProvider,
                token,
                this.priceGetter,
                lockbox.lockbox,
                this.logger,
              );

              if (balance) {
                const { tokenName, tokenAddress } =
                  await getManagedLockBoxCollateralInfo(
                    this.warpCore.multiProvider,
                    token,
                    lockbox.lockbox,
                  );

                updateManagedLockboxBalanceMetrics(
                  this.warpCore,
                  token.chainName,
                  tokenName,
                  tokenAddress,
                  lockbox.lockbox,
                  balance,
                  this.warpRouteId,
                  this.logger,
                );
              }
            },
            `Updating extra lockbox balance for contract at "${lockbox.lockbox}" on chain ${token.chainName}`,
            this.logger,
          ),
        );
      }
    }

    await Promise.all(promises);
  }

  static getWarpRouteCollateralTokenSymbol(tokens: Token[]): string {
    // We need to have a deterministic way to determine the symbol of the warp route
    // as its used to identify the warp route in metrics. This method should support routes where:
    // - All tokens have the same symbol, token standards can be all collateral, all synthetic or a mix
    // - All tokens have different symbol, but there is a collateral token to break the tie, where there are multiple collateral tokens, alphabetically first is chosen
    // - All tokens have different symbol, but there is no collateral token to break the tie, pick the alphabetically first symbol

    // Get all unique symbols from the tokens array
    const uniqueSymbols = new Set(tokens.map((token) => token.symbol));

    // If all tokens have the same symbol, return that symbol
    if (uniqueSymbols.size === 1) {
      return tokens[0].symbol;
    }

    // Find all collateralized tokens
    const collateralTokens = tokens.filter(
      (token) =>
        token.isCollateralized() ||
        token.standard === TokenStandard.EvmHypXERC20Lockbox,
    );

    if (collateralTokens.length === 0) {
      // If there are no collateralized tokens, return the alphabetically first symbol
      return [...uniqueSymbols].sort()[0];
    }

    // if there is a single unique collateral symbol return it or
    // if there are multiple, return the alphabetically first symbol
    const collateralSymbols = collateralTokens.map((token) => token.symbol);
    const uniqueCollateralSymbols = [...new Set(collateralSymbols)];

    return uniqueCollateralSymbols.sort()[0];
  }
}
