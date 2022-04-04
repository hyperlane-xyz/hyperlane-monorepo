import { BigNumber, ethers, FixedNumber } from 'ethers';

import { AbacusCore } from '..';
import { mulBigAndFixed } from '../utils';
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
   * A multiplier applied to the estimated source token payment amount.
   * @defaultValue 1.1
   */
  paymentEstimateMultiplier?: string;
  /**
   * A multiplier applied to the suggested destination gas price.
   * @defaultValue 1.1
   */
  destinationGasPriceMultiplier?: string;
  /**
   * Used to get the native token prices of the source and destination chains.
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
  destinationGasPriceMultiplier: ethers.FixedNumber;

  constructor(
    core: AbacusCore,
    config?: InterchainGasCalculatorConfig,
  ) {
    this.core = core;

    this.tokenPriceGetter =
      config?.tokenPriceGetter ?? new DefaultTokenPriceGetter();

    this.paymentEstimateMultiplier = FixedNumber.from(
      config?.paymentEstimateMultiplier ?? '1.1',
    );
    this.destinationGasPriceMultiplier = FixedNumber.from(
      config?.destinationGasPriceMultiplier ?? '1.1',
    );
  }

  /**
   * Calculates the estimated payment in source chain native tokens required
   * to cover the costs of proving and processing the message on the
   * destination chain. Considers the price of source and destination native
   * tokens, destination gas prices, and estimated gas required on the
   * destination chain. Applies the multiplier `paymentEstimateMultiplier`.
   * @param sourceDomain The domain of the source chain.
   * @param destinationDomain The domain of the destination chain.
   * @param destinationGas The amount of gas to pay for on the destination chain.
   * @returns An estimated amount of source chain tokens (in wei) to cover
   * gas costs of the message on the destination chain.
   */
  async estimateGasPayment(sourceDomain: number, destinationDomain: number, destinationGas: BigNumber): Promise<BigNumber> {
    const destinationPrice = await this.suggestedDestinationGasPrice(destinationDomain);
    const destinationCostWei = destinationGas.mul(destinationPrice);

    const sourceCostWei = await this.convertDestinationWeiToSourceWei(
      sourceDomain,
      destinationDomain,
      destinationCostWei,
    );

    // Applies a multiplier
    return mulBigAndFixed(
      sourceCostWei,
      this.paymentEstimateMultiplier,
      true, // ceil
    );
  }

  /**
   * Converts a given amount of destination chain native tokens (in wei)
   * to source chain native tokens (in wei). Considers the decimals of both
   * tokens and the exchange rate between the two determined by USD prices.
   * Note that if the source token decimals are too imprecise for the conversion
   * result, 0 may be returned.
   * @param sourceDomain The domain of the source chain.
   * @param destinationDomain The domain of the destination chain.
   * @param destinationWei The amount of destination chain native tokens (in wei).
   * @returns The amount of source chain native tokens (in wei) whose value matches
   * destinationWei.
   */
  async convertDestinationWeiToSourceWei(
    sourceDomain: number,
    destinationDomain: number,
    destinationWei: BigNumber,
  ): Promise<BigNumber> {
    // A FixedNumber that doesn't care what the decimals of the source/dest
    // tokens are -- it is just the amount of whole source tokens that a single
    // whole destination token is equivalent in value to.
    const srcTokensPerDestToken = await this.sourceTokensPerDestinationToken(sourceDomain, destinationDomain);

    // Using the src token / dest token price, convert the destination wei
    // to source token wei. This does not yet move from destination token decimals
    // to source token decimals.
    const sourceWeiWithDestinationDecimals = mulBigAndFixed(
      destinationWei,
      srcTokensPerDestToken,
      true, // ceil
    );

    // Converts sourceWeiWithDestinationDecimals to have the correct number of decimals.
    return convertDecimalValue(
      sourceWeiWithDestinationDecimals,
      this.nativeTokenDecimals(destinationDomain),
      this.nativeTokenDecimals(sourceDomain),
    );
  }

  /**
   * @param sourceDomain The domain of the source chain.
   * @param destinationDomain The domain of the destination chain.
   * @returns The exchange number of whole source tokens a single whole
   * destination token is equivalent in value to.
   */
  async sourceTokensPerDestinationToken(sourceDomain: number, destinationDomain: number): Promise<FixedNumber> {
    const sourceUsd = await this.tokenPriceGetter.getNativeTokenUsdPrice(sourceDomain);
    const destUsd = await this.tokenPriceGetter.getNativeTokenUsdPrice(destinationDomain);

    return destUsd.divUnsafe(sourceUsd);
  }

  /**
   * Gets a suggested gas price for the destination chain, applying the multiplier
   * `destinationGasPriceMultiplier`.
   * @param destinationDomain The domain of the destination chain.
   * @returns The suggested gas price in wei on the destination chain.
   */
  async suggestedDestinationGasPrice(destinationDomain: number): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(destinationDomain);
    const suggestedGasPrice = await provider.getGasPrice();

    // suggestedGasPrice * destinationGasPriceMultiplier
    return mulBigAndFixed(
      suggestedGasPrice,
      this.destinationGasPriceMultiplier,
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
      this.core.getDomain(domain)?.nativeTokenDecimals ??
      DEFAULT_TOKEN_DECIMALS
    );
  }
}

/**
 * Converts a value with `fromDecimals` decimals to a value with `toDecimals` decimals.
 * Incurs a loss of precision when `fromDecimals` > `toDecimals`.
 * @param value The value to convert.
 * @param fromDecimals The number of decimals `value` has.
 * @param toDecimals The number of decimals to convert `value` to.
 * @returns `value` represented with `toDecimals` decimals.
 */
function convertDecimalValue(
  value: BigNumber,
  fromDecimals: number,
  toDecimals: number,
): BigNumber {
  if (fromDecimals === toDecimals) {
    return value;
  } else if (fromDecimals > toDecimals) {
    return value.div(10 ** (fromDecimals - toDecimals));
  } else {
    // if (fromDecimals < toDecimals)
    return value.mul(10 ** (toDecimals - fromDecimals));
  }
}
