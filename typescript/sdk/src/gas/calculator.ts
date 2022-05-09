import {
  AbacusCore,
  MultiProvider,
  ParsedMessage,
  domains,
  resolveDomain,
  resolveNetworks,
} from '..';
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

// A generous estimation of the overhead gas amount when processing a message. This
// includes intrinsic gas, the merkle proof, making the external call to the recipient
// handle function, but does not account for any gas consumed by the handle function.
// This number was arrived at by estimating the proving and processing of a message
// whose body was small and whose recipient contract included only an empty fallback
// function. The estimated gas cost was 86777, which included the intrinsic cost.
// 130,000 is chosen as a generous buffer for safety. The large buffer is mostly to do
// with flexibility in message sizes, where large messages can cost more due to tx calldata,
// hashing, and calling to the recipient handle function.
const INBOX_PROCESS_OVERHEAD_GAS = 130_000;

// Intrinsic gas for a transaction. Does not consider calldata costs or differences in
// intrinsic gas or different networks.
const BASE_INTRINSIC_GAS = 21_000;

// The gas used if the quorum threshold of a signed checkpoint is zero.
// Includes intrinsic gas and all other gas that does not scale with the
// number of signatures. Note this does not consider differences in intrinsic gas for
// different chains.
// Derived by observing the amount of gas consumed for a quorum of 1 (~86800 gas),
// subtracting the gas used per signature, and rounding up for safety.
const BASE_CHECKPOINT_RELAY_GAS = 80_000;

// The amount of gas used for each signature when a signed checkpoint
// is submitted for verification.
// Really observed to be about 8350, but rounding up for safety.
const CHECKPOINT_RELAY_GAS_PER_SIGNATURE = 9_000;

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
  multiProvider: MultiProvider;

  tokenPriceGetter: TokenPriceGetter;

  paymentEstimateMultiplier: ethers.FixedNumber;
  messageGasEstimateBuffer: ethers.BigNumber;

  constructor(
    multiProvider: MultiProvider,
    core: AbacusCore,
    config?: InterchainGasCalculatorConfig,
  ) {
    this.multiProvider = multiProvider;
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
   * Given an amount of gas the message's recipient `handle` function is expected
   * to use, calculates the estimated payment denominated in the native
   * token of the origin chain. Considers the exchange rate between the native
   * tokens of the origin and destination chains, the suggested gas price on
   * the destination chain, gas costs incurred by a relayer when submitting a signed
   * checkpoint to the destination chain, and the overhead gas cost in Inbox of processing
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
    const inboxProcessOverheadGas = await this.inboxProcessOverheadGas();
    const totalDestinationGas = checkpointRelayGas
      .add(inboxProcessOverheadGas)
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
    const provider = this.multiProvider.getDomainConnection(
      resolveDomain(domain),
    ).provider!;
    return provider.getGasPrice();
  }

  /**
   * Gets the number of decimals of the provided domain's native token.
   * @param domain The domain.
   * @returns The number of decimals of `domain`'s native token.
   */
  nativeTokenDecimals(domain: number) {
    return (
      domains[resolveDomain(domain)].nativeTokenDecimals ??
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
   * 2. A buffer to account for inaccuracies in the above estimation.
   * @param message The message to estimate recipient `handle` gas usage for.
   * @returns The estimated gas required by the message's recipient handle function
   * on the destination chain.
   */
  async estimateHandleGasForMessage(
    message: ParsedMessage,
  ): Promise<BigNumber> {
    const provider = this.multiProvider.getDomainConnection(
      resolveDomain(message.destination),
    ).provider!;

    const messageNetworks = resolveNetworks(message);
    const { inbox } = this.core.getMailboxPair(
      messageNetworks.origin as never,
      messageNetworks.destination,
    );

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
    // Note the "real" intrinsic gas will always be higher than this.intrinsicGas
    // due to calldata costs, but this is desired because subtracting the lower bound
    // this.intrinsicGas will result in a more generous final estimate.
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
  async checkpointRelayGas(
    originDomain: number,
    destinationDomain: number,
  ): Promise<BigNumber> {
    const inboxValidatorManager = this.core.getContracts(
      resolveDomain(destinationDomain) as never,
    ).inboxes[resolveDomain(originDomain)].validatorManager;
    const threshold = await inboxValidatorManager.threshold();

    return threshold
      .mul(CHECKPOINT_RELAY_GAS_PER_SIGNATURE)
      .add(BASE_CHECKPOINT_RELAY_GAS);
  }

  /**
   * @returns A generous estimation of the gas consumption of all prove and process
   * operations within Inbox.sol, including intrinsic gas. Does not include any gas
   * consumed within a message's recipient `handle` function.
   * Returns a Promise because we expect this to eventually include async logic to
   * estimate sovereign consensus costs, and we'd like to keep the interface consistent.
   */
  inboxProcessOverheadGas(): Promise<BigNumber> {
    // This does not consider that different domains can possibly have different gas costs.
    // Consider this being configurable for each domain, or investigate ways to estimate
    // this over RPC.
    // Also does not consider gas usage that may scale with message size, e.g. calldata
    // costs.
    return Promise.resolve(BigNumber.from(INBOX_PROCESS_OVERHEAD_GAS));
  }

  /**
   * @returns The intrinsic gas of a basic transaction. Note this does not consider calldata
   * costs or potentially different intrinsic gas costs for different chains.
   */
  get intrinsicGas(): BigNumber {
    return BigNumber.from(BASE_INTRINSIC_GAS);
  }
}
