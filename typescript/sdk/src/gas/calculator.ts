import { BigNumber, ethers, FixedNumber } from 'ethers';
import { utils } from '@abacus-network/utils';

import { AbacusCore } from '..';
import { ParsedMessage } from '../utils';
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
   * A multiplier applied to the suggested gas price.
   * @defaultValue 1.1
   */
  suggestedGasPriceMultiplier?: string;
  /**
   * An amount of additional gas to add to the estimated gas of processing a message.
   * Only used when estimating a payment from a message.
   * @defaultValue 50,000
   */
  messageGasEstimateBuffer?: string;
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
  messageGasEstimateBuffer: ethers.BigNumber;

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
    this.messageGasEstimateBuffer = BigNumber.from(
      config?.messageGasEstimateBuffer ?? 50_000,
    );
  }

  /**
   * Calculates the estimated payment for an amount of gas on the destination chain,
   * denominated in the native token of the origin chain. Considers the exchange
   * rate between the native tokens of the origin and destination chains, and the
   * suggested gas price on the destination chain. Applies the multiplier
   * `paymentEstimateMultiplier`.
   * @param originDomain The domain of the origin chain.
   * @param destinationDomain The domain of the destination chain.
   * @param destinationGas The amount of gas to pay for on the destination chain.
   * @returns An estimated amount of origin chain tokens to cover gas costs of the
   * message on the destination chain.
   */
  async estimatePaymentForGasAmount(
    originDomain: number,
    destinationDomain: number,
    destinationGas: BigNumber,
  ): Promise<BigNumber> {
    const destinationGasPrice = await this.suggestedGasPrice(destinationDomain);
    const destinationCostWei = destinationGas.mul(destinationGasPrice);

    // Convert from destination domain native tokens to origin domain native tokens.
    const originCostWei = await this.convertBetweenNativeTokens(
      destinationDomain,
      originDomain,
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
   * Calculates the estimated payment to process the message on its destination chain,
   * denominated in the native token of the origin chain. The destination gas is
   * determined by estimating the gas to process the provided message, which is then used
   * to calculate the payment using {@link estimatePaymentForGasAmount}.
   * @param message The parsed message to estimate payment for.
   * @returns An estimated amount of origin chain tokens to cover gas costs of the
   * message on the destination chain.
   */
  async estimatePaymentForMessage(message: ParsedMessage) {
    const destinationGas = await this.estimateGasForMessage(message);
    return this.estimatePaymentForGasAmount(
      message.origin,
      message.destination,
      destinationGas,
    );
  }

  /**
   * Using the exchange rates provided by tokenPriceGetter, returns the amount of
   * `toDomain` native tokens equivalent in value to the provided `fromAmount` of
   * `fromDomain` native tokens. Accounts for differences in the decimals of the tokens.
   * @param fromDomain The domain whose native token is being converted from.
   * @param toDomain The domain whose native token is being converted into.
   * @param fromAmount The amount of `fromDomain` native tokens to convert from.
   * @returns The amount of `toDomain` native tokens whose value is equivalent to
   * `fromAmount` of `fromDomain` native tokens.
   */
  async convertBetweenNativeTokens(
    fromDomain: number,
    toDomain: number,
    fromAmount: BigNumber,
  ): Promise<BigNumber> {
    // A FixedNumber that doesn't care what the decimals of the from/to
    // tokens are -- it is just the amount of whole from tokens that a single
    // whole to token is equivalent in value to.
    const exchangeRate = await this.getExchangeRate(toDomain, fromDomain);

    // Apply the exchange rate to the amount. This does not yet account for differences in
    // decimals between the two tokens.
    const exchangeRateProduct = mulBigAndFixed(
      fromAmount,
      exchangeRate,
      true, // ceil
    );

    // Converts exchangeRateProduct to having the correct number of decimals.
    return convertDecimalValue(
      exchangeRateProduct,
      this.nativeTokenDecimals(fromDomain),
      this.nativeTokenDecimals(toDomain),
    );
  }

  /**
   * @param baseDomain The domain whose native token is the base asset.
   * @param quoteDomain The domain whose native token is the quote asset.
   * @returns The exchange rate of the native tokens of the baseDomain and the quoteDomain.
   * I.e. the number of whole quote tokens a single whole base token is equivalent
   * in value to.
   */
  async getExchangeRate(
    baseDomain: number,
    quoteDomain: number,
  ): Promise<FixedNumber> {
    const baseUsd = await this.tokenPriceGetter.getNativeTokenUsdPrice(
      baseDomain,
    );
    const quoteUsd = await this.tokenPriceGetter.getNativeTokenUsdPrice(
      quoteDomain,
    );

    // This operation is called "unsafe" because of the unintuitive rounding that
    // can occur due to fixed point arithmetic. We're not overly concerned about perfect
    // precision because we're operating with fixed128x18, which has 18 decimals of
    // precision, and gas payments are regardless expected to have a generous buffer to account
    // for movements in native token prices or gas prices.
    // For more details on FixedPoint arithmetic being "unsafe", see
    // https://github.com/ethers-io/ethers.js/issues/1322#issuecomment-787430115.
    return quoteUsd.divUnsafe(baseUsd);
  }

  /**
   * Gets a suggested gas price for the destination chain, applying the multiplier
   * `destinationGasPriceMultiplier`.
   * @param destinationDomain The domain of the destination chain.
   * @returns The suggested gas price in wei on the destination chain.
   */
  async suggestedGasPrice(domain: number): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(domain);
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

  /**
   * Estimates the amount of gas required to process a message on its destination chain.
   * This does not assume the Inbox of the destination domain has a checkpoint that
   * the message is included in. Therefore, we estimate the gas by summing:
   * 1. The intrinsic gas cost of a transaction on the destination chain.
   * 2. Any gas costs imposed by operations in the Inbox, including proving
   *    the message and logic surrounding the processing of a message.
   * 3. The estimated gas consumption of a direct call to the `handle`
   *    function of the recipient address using the correct parameters and
   *    setting the `from` address of the transaction to the address of the inbox.
   * 4. A buffer to account for inaccuracies in the above estimations.
   * @returns The estimated gas required to process the message on the destination chain.
   */
  async estimateGasForMessage(message: ParsedMessage): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(message.destination);
    const inbox = this.core.mustGetInbox(message.origin, message.destination);

    const handlerInterface = new ethers.utils.Interface([
      'function handle(uint32,bytes32,bytes)',
    ]);
    // Estimates a direct call to the `handle` function of the recipient
    // with the `from` address set to the inbox.
    // This includes intrinsic gas, so no need to add it
    const directHandleCallGas = await provider.estimateGas({
      to: utils.bytes32ToAddress(message.recipient),
      from: inbox.address,
      data: handlerInterface.encodeFunctionData('handle', [
        message.origin,
        message.sender,
        message.body,
      ]),
    });

    // directHandleCallGas includes the intrinsic gas
    return directHandleCallGas
      .add(this.inboxProvingAndProcessingGas)
      .add(this.messageGasEstimateBuffer);
  }

  /**
   * @returns A generous estimation of the gas consumption of all prove and process
   * operations in Inbox.sol, excluding:
   * 1. Intrinsic gas.
   * 2. Any gas consumed within a `handle` function when processing a message once called.
   */
  get inboxProvingAndProcessingGas() {
    // This does not consider that different domains can possibly have different gas costs.
    // Consider this being configurable for each domain, or investigate ways to estimate
    // this over RPC.
    //
    // This number was arrived at by estimating the proving and processing of a message
    // whose recipient contract included only an empty fallback function. The estimated
    // gas cost was ~100,000 which includes the intrinsic cost, but 150,000 is chosen as
    // a generous buffer.
    return 150_000;
  }
}
