import { AbacusCore, MultiProvider, chainMetadata } from '..';
import { BigNumber, FixedNumber, ethers } from 'ethers';

import { utils } from '@abacus-network/utils';

import { ChainName, Remotes } from '../types';

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

// If a chain doesn't specify how many decimals their native token has, 18 is used.
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
// intrinsic gas or different chains.
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

export type ParsedMessage<
  Chain extends ChainName,
  Destination extends Chain,
> = {
  origin: Exclude<Chain, Destination>;
  sender: string;
  destination: Destination;
  recipient: string;
  body: string;
};

/**
 * Calculates interchain gas payments.
 */
export class InterchainGasCalculator<Chain extends ChainName> {
  core: AbacusCore<Chain>;
  multiProvider: MultiProvider<Chain>;

  tokenPriceGetter: TokenPriceGetter;

  paymentEstimateMultiplier: ethers.FixedNumber;
  messageGasEstimateBuffer: ethers.BigNumber;

  constructor(
    multiProvider: MultiProvider<Chain>,
    core: AbacusCore<Chain>,
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
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param destinationHandleGas The amount of gas the recipient `handle` function
   * is estimated to use.
   * @returns An estimated amount of origin chain tokens to cover gas costs of the
   * message on the destination chain.
   */
  async estimatePaymentForHandleGasAmount<Destination extends Chain>(
    origin: Exclude<Chain, Destination>,
    destination: Destination,
    destinationHandleGas: BigNumber,
  ): Promise<BigNumber> {
    const [destinationGasPrice, checkpointRelayGas, inboxProcessOverheadGas] =
      await Promise.all([
        this.suggestedGasPrice(destination),
        this.checkpointRelayGas(origin, destination),
        this.inboxProcessOverheadGas(),
      ]);
    const totalDestinationGas = checkpointRelayGas
      .add(inboxProcessOverheadGas)
      .add(destinationHandleGas);
    const destinationCostWei = totalDestinationGas.mul(destinationGasPrice);

    // Convert from destination chain native tokens to origin chain native tokens.
    const originCostWei = await this.convertBetweenNativeTokens(
      destination,
      origin,
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
  async estimatePaymentForMessage<Destination extends Chain>(
    message: ParsedMessage<Chain, Destination>,
  ) {
    const destinationGas = await this.estimateHandleGasForMessage(message);
    return this.estimatePaymentForHandleGasAmount(
      message.origin,
      message.destination,
      destinationGas,
    );
  }

  /**
   * Using the exchange rates provided by tokenPriceGetter, returns the amount of
   * `toChain` native tokens equivalent in value to the provided `fromAmount` of
   * `fromChain` native tokens. Accounts for differences in the decimals of the tokens.
   * @param fromChain The chain whose native token is being converted from.
   * @param toChain The chain whose native token is being converted into.
   * @param fromAmount The amount of `fromChain` native tokens to convert from.
   * @returns The amount of `toChain` native tokens whose value is equivalent to
   * `fromAmount` of `fromChain` native tokens.
   */
  async convertBetweenNativeTokens(
    fromChain: Chain,
    toChain: Chain,
    fromAmount: BigNumber,
  ): Promise<BigNumber> {
    // A FixedNumber that doesn't care what the decimals of the from/to
    // tokens are -- it is just the amount of whole from tokens that a single
    // whole to token is equivalent in value to.
    const exchangeRate = await this.getExchangeRate(toChain, fromChain);

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
      this.nativeTokenDecimals(fromChain),
      this.nativeTokenDecimals(toChain),
    );
  }

  /**
   * @param baseChain The chain whose native token is the base asset.
   * @param quoteChain The chain whose native token is the quote asset.
   * @returns The exchange rate of the native tokens of the baseChain and the quoteChain.
   * I.e. the number of whole quote tokens a single whole base token is equivalent
   * in value to.
   */
  async getExchangeRate(
    baseChain: Chain,
    quoteChain: Chain,
  ): Promise<FixedNumber> {
    const baseUsd = await this.tokenPriceGetter.getNativeTokenUsdPrice(
      baseChain,
    );
    const quoteUsd = await this.tokenPriceGetter.getNativeTokenUsdPrice(
      quoteChain,
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
   * Gets a suggested gas price for a chain.
   * @param chainName The name of the chain to get the gas price for
   * @returns The suggested gas price in wei on the destination chain.
   */
  async suggestedGasPrice(chainName: Chain): Promise<BigNumber> {
    const provider = this.multiProvider.getChainConnection(chainName).provider!;
    return provider.getGasPrice();
  }

  /**
   * Gets the number of decimals of the provided chain's native token.
   * @param chain The chain.
   * @returns The number of decimals of `chain`'s native token.
   */
  nativeTokenDecimals(chain: Chain) {
    return chainMetadata[chain].nativeTokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  }

  /**
   * Estimates the amount of gas used by message's recipient `handle` function
   * on its destination chain. This does not assume the Inbox of the destination
   * chain has a checkpoint that the message is included in, and does not
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
  async estimateHandleGasForMessage<LocalChain extends Chain>(
    message: ParsedMessage<Chain, LocalChain>,
  ): Promise<BigNumber> {
    const provider = this.multiProvider.getChainConnection(message.destination)
      .provider!;

    const { destinationInbox } = this.core.getMailboxPair<LocalChain>(
      message.origin,
      message.destination,
    );

    const handlerInterface = new ethers.utils.Interface([
      'function handle(uint32,bytes32,bytes)',
    ]);
    // Estimates a direct call to the `handle` function of the recipient
    // with the `from` address set to the inbox.
    // This includes intrinsic gas.
    const directHandleCallGas = await provider.estimateGas({
      to: utils.bytes32ToAddress(message.recipient),
      from: destinationInbox.address,
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
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @returns An estimated gas amount a relayer will spend when submitting a signed
   * checkpoint to the destination chain.
   */
  async checkpointRelayGas<Destination extends Chain>(
    origin: Remotes<Chain, Destination>,
    destination: Destination,
  ): Promise<BigNumber> {
    const inboxes = this.core.getContracts(destination).inboxes;
    const threshold = await inboxes[origin].inboxValidatorManager.threshold();

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
    // This does not consider that different chains can possibly have different gas costs.
    // Consider this being configurable for each chain, or investigate ways to estimate
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
