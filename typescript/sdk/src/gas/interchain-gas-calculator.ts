import { BigNumber, ethers, FixedNumber } from 'ethers';

import { AbacusCore } from '..';
import { convertDecimalValue, mulBigAndFixed } from './utils';
import { DefaultTokenPriceGetter, TokenPriceGetter } from './token-prices';

/**
 * A note on arithmetic:
 * The ethers.BigNumber implementation behaves very similar to Solidity's
 * number handling by not supporting decimals. To avoid adding another big
 * number implementation as a dependency, we use ethers.FixedNumber, a
 * fixed point implementation intended to model how Solidity's half-supported
 * fixed point numbers work, see https://docs.soliditylang.org/en/v0.8.13/types.html#fixed-point-numbers).
 *
 * Generally, ceiling is used rather than floor here to err on the side of over-
 * estimating amounts.
 */

// If a domain doesn't specify how many decimals their native token has, 18 is used.
const DEFAULT_TOKEN_DECIMALS = 18;

export interface InterchainGasCalculatorConfig {
  /**
   * A multiplier applied to the estimated origin token payment amount.
   * @defaultValue 1.1
   */
  paymentEstimateMultiplier?: string;
  /**
   * A multiplier applied to the suggested destination gas price.
   * @defaultValue 1.1
   */
  suggestedGasPriceMultiplier?: string;
  /**
   * Used to get the native token prices of the origin and destination chains.
   * @defaultValue An instance of DefaultTokenPriceGetter.
   */
  tokenPriceGetter?: TokenPriceGetter;
}

/**
 * An undispatched Abacus message that will pay destination gas costs.
 */
export class InterchainGasCalculator {
  core: AbacusCore;

  tokenPriceGetter: TokenPriceGetter;

  paymentEstimateMultiplier: ethers.FixedNumber;
  suggestedGasPriceMultiplier: ethers.FixedNumber;

  constructor(core: AbacusCore, config?: InterchainGasCalculatorConfig) {
    this.core = core;

    this.tokenPriceGetter =
      config?.tokenPriceGetter ?? new DefaultTokenPriceGetter();

    this.paymentEstimateMultiplier = FixedNumber.from(
      config?.paymentEstimateMultiplier ?? '1.1',
    );
    this.suggestedGasPriceMultiplier = FixedNumber.from(
      config?.suggestedGasPriceMultiplier ?? '1.1',
    );
  }

  /**
   * Calculates the estimated payment in origin chain native tokens required
   * to cover the costs of proving and processing the message on the
   * destination chain. Considers the price of origin and destination native
   * tokens, destination gas prices, and estimated gas required on the
   * destination chain. Applies the multiplier `paymentEstimateMultiplier`.
   * @param originDomain The domain of the origin chain.
   * @param destinationDomain The domain of the destination chain.
   * @param destinationGas The amount of gas to pay for on the destination chain.
   * @returns An estimated amount of origin chain tokens (in wei) to cover
   * gas costs of the message on the destination chain.
   */
  async estimateGasPayment(
    originDomain: number,
    destinationDomain: number,
    destinationGas: BigNumber,
  ): Promise<BigNumber> {
    const destinationPrice = await this.suggestedDestinationGasPrice(
      destinationDomain,
    );
    const destinationCostWei = destinationGas.mul(destinationPrice);

    const originCostWei = await this.convertDestinationWeiToOriginWei(
      originDomain,
      destinationDomain,
      destinationCostWei,
    );

    // Applies a multiplier
    return mulBigAndFixed(
      originCostWei,
      this.paymentEstimateMultiplier,
      true, // ceil
    );
  }

  /**
   * Converts a given amount of destination chain native tokens (in wei)
   * to origin chain native tokens (in wei). Considers the decimals of both
   * tokens and the exchange rate between the two determined by USD prices.
   * Note that if the origin token decimals are too imprecise for the conversion
   * result, 0 may be returned.
   * @param originDomain The domain of the origin chain.
   * @param destinationDomain The domain of the destination chain.
   * @param destinationWei The amount of destination chain native tokens (in wei).
   * @returns The amount of origin chain native tokens (in wei) whose value matches
   * destinationWei.
   */
  async convertDestinationWeiToOriginWei(
    originDomain: number,
    destinationDomain: number,
    destinationWei: BigNumber,
  ): Promise<BigNumber> {
    // A FixedNumber that doesn't care what the decimals of the origin/dest
    // tokens are -- it is just the amount of whole origin tokens that a single
    // whole destination token is equivalent in value to.
    const srcTokensPerDestToken = await this.originTokensPerDestinationToken(
      originDomain,
      destinationDomain,
    );

    // Using the src token / dest token price, convert the destination wei
    // to origin token wei. This does not yet move from destination token decimals
    // to origin token decimals.
    const originWeiWithDestinationDecimals = mulBigAndFixed(
      destinationWei,
      srcTokensPerDestToken,
      true, // ceil
    );

    // Converts originWeiWithDestinationDecimals to have the correct number of decimals.
    return convertDecimalValue(
      originWeiWithDestinationDecimals,
      this.nativeTokenDecimals(destinationDomain),
      this.nativeTokenDecimals(originDomain),
    );
  }

  /**
   * @param originDomain The domain of the origin chain.
   * @param destinationDomain The domain of the destination chain.
   * @returns The exchange number of whole origin tokens a single whole
   * destination token is equivalent in value to.
   */
  async originTokensPerDestinationToken(
    originDomain: number,
    destinationDomain: number,
  ): Promise<FixedNumber> {
    const originUsd = await this.tokenPriceGetter.getNativeTokenUsdPrice(
      originDomain,
    );
    const destUsd = await this.tokenPriceGetter.getNativeTokenUsdPrice(
      destinationDomain,
    );

    return destUsd.divUnsafe(originUsd);
  }

  /**
   * Gets a suggested gas price for the destination chain, applying the multiplier
   * `destinationGasPriceMultiplier`.
   * @param destinationDomain The domain of the destination chain.
   * @returns The suggested gas price in wei on the destination chain.
   */
  async suggestedDestinationGasPrice(
    destinationDomain: number,
  ): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(destinationDomain);
    const suggestedGasPrice = await provider.getGasPrice();

    // suggestedGasPrice * destinationGasPriceMultiplier
    return mulBigAndFixed(
      suggestedGasPrice,
      this.suggestedGasPriceMultiplier,
      true, // ceil
    );
  }

  /**
   * Gets the number of decimals of the provided domain's native token.
   * @param domain The domain.
   * @returns The number of decimals of `domain`'s native token.
   */
  nativeTokenDecimals(domain: number) {
    return (
      this.core.getDomain(domain)?.nativeTokenDecimals ?? DEFAULT_TOKEN_DECIMALS
    );
  }
}
