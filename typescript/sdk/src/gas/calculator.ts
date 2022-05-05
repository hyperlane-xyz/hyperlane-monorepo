import { AbacusCore, ParsedMessage } from '..';
import { BigNumber, FixedNumber, ethers } from 'ethers';

import { utils } from '@abacus-network/utils';

import { DefaultTokenPriceGetter, TokenPriceGetter } from './token-prices';
import { convertDecimalValue, mulBigAndFixed } from './utils';

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
   * This should be high enough to account for movements in token exchange
   * rates and gas prices.
   * @defaultValue 1.25
   */
  paymentEstimateMultiplier?: string;
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
 * Calculates interchain gas payments.
 */
export class InterchainGasCalculator {
  core: AbacusCore;

  tokenPriceGetter: TokenPriceGetter;

  paymentEstimateMultiplier: ethers.FixedNumber;
  messageGasEstimateBuffer: ethers.BigNumber;

  constructor(core: AbacusCore, config?: InterchainGasCalculatorConfig) {
    this.core = core;

    this.tokenPriceGetter =
      config?.tokenPriceGetter ?? new DefaultTokenPriceGetter();

    this.paymentEstimateMultiplier = FixedNumber.from(
      config?.paymentEstimateMultiplier ?? '1.25',
    );
    this.messageGasEstimateBuffer = BigNumber.from(
      config?.messageGasEstimateBuffer ?? 50_000,
    );
  }

  /**
   * Calculates the estimated payment given an amount of gas the message's
   * recipient `handle` function is expected to use denominated in the native
   * token of the origin chain. Considers the exchange rate between the native
   * tokens of the origin and destination chains, the suggested gas price on
   * the destination chain, gas costs incurred by a relayer when submitting a signed
   * checkpoint to the destination chain, and the overhead gas cost of processing
   * a message. Applies the multiplier `paymentEstimateMultiplier`.
   * @param originDomain The domain of the origin chain.
   * @param destinationDomain The domain of the destination chain.
   * @param destinationHandleGas The amount of gas the recipient `handle` function
   * is estimated to use.
   * @returns An estimated amount of origin chain tokens to cover gas costs of the
   * message on the destination chain.
   */
  async estimatePaymentForHandleGasAmount(
    originDomain: number,
    destinationDomain: number,
    destinationHandleGas: BigNumber,
  ): Promise<BigNumber> {
    const destinationGasPrice = await this.suggestedGasPrice(destinationDomain);

    const checkpointRelayGas = await this.checkpointRelayGas(
      originDomain,
      destinationDomain,
    );
    const totalDestinationGas = checkpointRelayGas
      .add(this.inboxProcessOverheadGas)
      .add(destinationHandleGas);
    const destinationCostWei = totalDestinationGas.mul(destinationGasPrice);

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
   * denominated in the native token of the origin chain. The gas used by the message's
   * recipient handler function is estimated in an eth_estimateGas call to the
   * destination chain, and is then used to calculate the payment using
   * {@link estimatePaymentForHandleGasAmount}.
   * @param message The parsed message to estimate payment for.
   * @returns An estimated amount of origin chain tokens to cover gas costs of the
   * message on the destination chain.
   */
  async estimatePaymentForMessage(message: ParsedMessage) {
    const destinationGas = await this.estimateHandleGasForMessage(message);
    return this.estimatePaymentForHandleGasAmount(
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
   * Gets a suggested gas price for a domain.
   * @param domain The domain of the chain to estimate gas prices for.
   * @returns The suggested gas price in wei on the destination chain.
   */
  async suggestedGasPrice(domain: number): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(domain);
    return provider.getGasPrice();
  }

  /**
   * Gets the number of decimals of the provided domain's native token.
   * @param domain The domain.
   * @returns The number of decimals of `domain`'s native token.
   */
  nativeTokenDecimals(domain: number) {
    return (
      this.core.mustGetDomain(domain).nativeTokenDecimals ??
      DEFAULT_TOKEN_DECIMALS
    );
  }

  /**
   * Estimates the amount of gas used by message's recipient `handle` function
   * on its destination chain. This does not assume the Inbox of the destination
   * domain has a checkpoint that the message is included in, and does not
   * consider intrinsic gas or any "overhead" gas incurred by Inbox.process.
   * The estimated gas returned is the sum of:
   * 1. The estimated gas consumption of a direct call to the `handle`
   *    function of the recipient address using the correct parameters and
   *    setting the `from` address of the transaction to the address of the inbox.
   * 2. A buffer to account for inaccuracies in the above estimations.
   * @param message The message to estimate recipient `handle` gas usage for.
   * @returns The estimated gas required by the message's recipient handle function
   * on the destination chain.
   */
  async estimateHandleGasForMessage(message: ParsedMessage): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(message.destination);
    const inbox = this.core.mustGetInbox(message.origin, message.destination);

    const handlerInterface = new ethers.utils.Interface([
      'function handle(uint32,bytes32,bytes)',
    ]);
    // Estimates a direct call to the `handle` function of the recipient
    // with the `from` address set to the inbox.
    // This includes intrinsic gas.
    const directHandleCallGas = await provider.estimateGas({
      to: utils.bytes32ToAddress(message.recipient),
      from: inbox.address,
      data: handlerInterface.encodeFunctionData('handle', [
        message.origin,
        message.sender,
        message.body,
      ]),
    });

    // Subtract intrinsic gas, which is included in directHandleCallGas.
    // Note in the intrinsic gas will always be higher than this.intrinsicGas
    // due to calldata costs, but that's desired because it results in a generous estimate here.
    return directHandleCallGas
      .add(this.messageGasEstimateBuffer)
      .sub(this.intrinsicGas);
  }

  /**
   * @param originDomain The domain of the origin chain.
   * @param destinationDomain The domain of the destination chain.
   * @returns An estimated gas amount a relayer will spend when submitting a signed
   * checkpoint to the destination domain.
   */
  async checkpointRelayGas(originDomain: number, destinationDomain: number): Promise<BigNumber> {
    // The gas used if the quorum threshold of a signed checkpoint is zero.
    // Includes intrinsic gas and all other gas that does not scale with the
    // number of signatures. Note this does not consider differences in intrinsic gas for
    // different chains.
    // Derived by observing the amount of gas consumed for a quorum of 1 (~86800 gas),
    // subtracting a the scaling gas per signature, and rounding up for safety.
    const baseGasAmount = 80_000;
    // Really observed to be about 8350, but rounding up for safety.
    const gasPerSignature = 9_000;

    const validatorManager = this.core.mustGetInboxValidatorManager(originDomain, destinationDomain);
    const threshold = await validatorManager.threshold();

    return threshold.mul(gasPerSignature)
      .add(baseGasAmount);
  }

  /**
   * @returns A generous estimation of the gas consumption of all prove and process
   * operations in Inbox.sol, excluding:
   * 1. Intrinsic gas.
   * 2. Any gas consumed within a `handle` function when processing a message once called.
   */
  get inboxProcessOverheadGas(): BigNumber {
    // This does not consider that different domains can possibly have different gas costs.
    // Consider this being configurable for each domain, or investigate ways to estimate
    // this over RPC.
    //
    // This number was arrived at by estimating the proving and processing of a message
    // whose body was small and whose recipient contract included only an empty fallback
    // function. The estimated gas cost was 86777, which included the intrinsic cost.
    // 100,000 is chosen as a generous buffer for safety.
    return BigNumber.from(100_000);
  }

  /**
   * @returns The intrinsic gas of a basic transaction. Note this does not consider calldata
   * costs or potentially different intrinsic gas costs for different chains.
   */
  get intrinsicGas(): BigNumber {
    return BigNumber.from(21_000);
  }
}
