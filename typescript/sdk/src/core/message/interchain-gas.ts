import { BigNumber, ethers, FixedNumber } from 'ethers';

import { AbacusCore } from '..';
import { mulBigAndFixed } from '../../utils';
import { DefaultTokenPriceGetter, TokenPriceGetter } from '../token-prices';
import { BaseMessage } from './base';

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

export interface InterchainGasPaymentConfig {
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
   * An amount of additional gas to add to the destination chain gas estimation.
   * @defaultValue 50,000
   */
  destinationGasEstimateBuffer?: ethers.BigNumberish;
  /**
   * Used to get the native token prices of the source and destination chains.
   * @defaultValue An instance of DefaultTokenPriceGetter.
   */
  tokenPriceGetter?: TokenPriceGetter;
}

/**
 * An undispatched Abacus message that will pay destination gas costs.
 */
export class InterchainGasPayingMessage extends BaseMessage {
  tokenPriceGetter: TokenPriceGetter;

  paymentEstimateMultiplier: ethers.FixedNumber;
  destinationGasPriceMultiplier: ethers.FixedNumber;
  destinationGasEstimateBuffer: ethers.BigNumber;

  constructor(
    core: AbacusCore,
    serializedMessage: string,
    config?: InterchainGasPaymentConfig,
  ) {
    super(core, serializedMessage);

    this.tokenPriceGetter =
      config?.tokenPriceGetter ?? new DefaultTokenPriceGetter();

    this.paymentEstimateMultiplier = FixedNumber.from(
      config?.paymentEstimateMultiplier ?? '1.1',
    );
    this.destinationGasPriceMultiplier = FixedNumber.from(
      config?.destinationGasPriceMultiplier ?? '1.1',
    );
    this.destinationGasEstimateBuffer = BigNumber.from(
      config?.destinationGasEstimateBuffer ?? 50_000,
    );
  }

  /**
   * Calculates the estimated payment in source chain native tokens required
   * to cover the costs of proving and processing the message on the
   * destination chain. Considers the price of source and destination native
   * tokens, destination gas prices, and estimated gas required on the
   * destination chain.
   * @returns An estimated amount of source chain tokens (in wei) to cover
   * gas costs of the message on the destination chain.
   */
  async estimateInterchainGasPayment(): Promise<BigNumber> {
    const destinationGas = await this.estimateDestinationGas();
    const destinationPrice = await this.suggestedDestinationGasPrice();
    const destinationCostWei = destinationGas.mul(destinationPrice);

    const sourceCostWei = await this.convertDestinationWeiToSourceWei(
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
   * @param destinationWei The amount of destination chain native tokens (in wei).
   * @returns The amount of source chain native tokens (in wei) whose value matches
   * destinationWei.
   */
  async convertDestinationWeiToSourceWei(
    destinationWei: BigNumber,
  ): Promise<BigNumber> {
    // A FixedNumber that doesn't care what the decimals of the source/dest
    // tokens are -- it is just the amount of whole source tokens that a single
    // whole destination token is equivalent in value to.
    const srcTokensPerDestToken = await this.sourceTokensPerDestinationToken();

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
      this.destinationTokenDecimals,
      this.sourceTokenDecimals,
    );
  }

  /**
   * Estimates the amount of gas required to prove and process the message.
   * This does not assume the Inbox of the destination domain has a
   * checkpoint that the message is included in. Therefore, we estimate
   * the gas by summing:
   * 1. The intrinsic gas cost of a transaction on the destination chain.
   * 2. Any gas costs imposed by operations in the Inbox, including proving
   *    the message and logic surrounding the processing of a message.
   * 3. The estimated gas consumption of a direct call to the `handle`
   *    function of the recipient address using the correct parameters and
   *    setting the `from` address of the transaction to the address of the inbox.
   * 4. A buffer to account for inaccuracies in the above estimations.
   * @returns The estimated gas required to prove and process the message
   * on the destination chain.
   */
  async estimateDestinationGas(): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(this.destination);
    const inbox = this.core.mustGetInbox(this.from, this.destination);

    const handlerInterface = new ethers.utils.Interface([
      'function handle(uint32,bytes32,bytes)',
    ]);
    // Estimates a direct call to the `handle` function of the recipient
    // with the `from` address set to the inbox.
    // This includes intrinsic gas, so no need to add it
    const directHandleCallGas = await provider.estimateGas({
      to: this.recipientAddress,
      from: inbox.address,
      data: handlerInterface.encodeFunctionData('handle', [
        this.from,
        this.sender,
        this.serializedMessage,
      ]),
    });

    // directHandleCallGas includes the intrinsic gas
    return directHandleCallGas
      .add(this.inboxProvingAndProcessingGas)
      .add(this.destinationGasEstimateBuffer);
  }

  /**
   * @returns The exchange number of whole source tokens a single whole
   * destination token is equivalent in value to.
   */
  async sourceTokensPerDestinationToken(): Promise<FixedNumber> {
    const sourceUsd = await this.sourceTokenPriceUsd();
    const destUsd = await this.destinationTokenPriceUsd();

    return destUsd.divUnsafe(sourceUsd);
  }

  /**
   * @returns The suggested gas price in wei on the destination chain.
   */
  async suggestedDestinationGasPrice(): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(this.destination);
    const suggestedGasPrice = await provider.getGasPrice();

    // suggestedGasPrice * destinationGasPriceMultiplier
    return mulBigAndFixed(
      suggestedGasPrice,
      this.destinationGasPriceMultiplier,
      true, // ceil
    );
  }

  /**
   * @return A generous estimation of the gas consumption of all prove and process
   * operations in Inbox.sol, excluding:
   * 1. Intrinsic gas.
   * 2. Any gas consumed within a `handle` function when processing a message once called.
   */
  get inboxProvingAndProcessingGas() {
    // TODO: This does not consider that different domains can possibly have
    // different gas costs. Consider this being configurable for each domain, or
    // investigate ways to estimate this over RPC.
    //
    // This number was arrived at by estimating the proving and processing of a message
    // whose recipient contract included only an empty fallback function. The estimated
    // gas cost was ~100,000 which includes the intrinsic cost, but 150,000 is chosen as
    // a generous buffer.
    return 150_000;
  }

  get sourceTokenDecimals(): number {
    return (
      this.core.getDomain(this.from)?.nativeTokenDecimals ??
      DEFAULT_TOKEN_DECIMALS
    );
  }

  async sourceTokenPriceUsd(): Promise<FixedNumber> {
    return this.tokenPriceGetter.getNativeTokenUsdPrice(this.from);
  }

  get destinationTokenDecimals(): number {
    return (
      this.core.getDomain(this.destination)?.nativeTokenDecimals ??
      DEFAULT_TOKEN_DECIMALS
    );
  }

  async destinationTokenPriceUsd(): Promise<FixedNumber> {
    return this.tokenPriceGetter.getNativeTokenUsdPrice(this.destination);
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
