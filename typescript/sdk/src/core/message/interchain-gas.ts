import { BigNumber, ethers, FixedNumber } from 'ethers';

import { AbacusCore } from '..';
import { TestTokenPriceGetter, TokenPriceGetter } from '../token-prices';
import { BaseMessage } from './base';

/**
 * A note on arithmetic:
 * The ethers.BigNumber implementation behaves very similar to Solidity's
 * number handling by not supporting decimals. To avoid adding another big
 * number implementation as a dependency, we use ethers.FixedNumber, a
 * fixed point implementation intended to model how Solidity's half-supported
 * fixed point numbers work, see https://docs.soliditylang.org/en/v0.8.13/types.html#fixed-point-numbers).
 */

const DEFAULT_TOKEN_DECIMALS = 18;

export class InterchainGasPayingMessage extends BaseMessage {
  public tokenPriceGetter: TokenPriceGetter;

  public destinationGasEstimateBuffer: ethers.BigNumberish;
  public interchainGasPaymentEstimateMultiplier: ethers.FixedNumber;
  public destinationGasPriceMultiplier: ethers.FixedNumber;

  constructor(core: AbacusCore, serializedMessage: string) {
    super(core, serializedMessage);

    this.tokenPriceGetter = new TestTokenPriceGetter();

    this.destinationGasEstimateBuffer = BigNumber.from(50_000);
    this.interchainGasPaymentEstimateMultiplier = FixedNumber.from('1.1');
    this.destinationGasPriceMultiplier = FixedNumber.from('1.1');
  }

  /**
   * Returns the estimated payment in source native tokens required
   * to cover the costs of proving and processing the message on the
   * destination chain.
   */
  async estimateInterchainGasPayment() {
    const destinationGas = await this.estimateDestinationGas();
    console.log('destinationGas', destinationGas.toString())
    const destinationPrice = await this.suggestedDestinationGasPrice();
    console.log('destinationPrice', destinationPrice.toString())
    const destinationCostWei = destinationGas.mul(destinationPrice);
    console.log('destinationCostWei', destinationCostWei.toString())

    return this.convertDestinationWeiToSourceWei(destinationCostWei);
  }

  async convertDestinationWeiToSourceWei(destinationWei: BigNumber) {
    // A FixedNumber that doesn't care what the decimals of the source/dest
    // tokens are -- it is just the amount of whole src tokens a single destination
    // token corresponds to.
    const srcTokensPerDestToken = await this.sourceTokensPerDestinationToken();

    console.log('srcTokensPerDestToken', srcTokensPerDestToken.toString())

    // Using the src token / dest token price, convert the destination wei
    // to source token wei. This does not yet move from destination token decimals
    // to source token decimals.
    const sourceWeiWithDestinationDecimals = mulBigAndFixed(
      destinationWei,
      srcTokensPerDestToken
    );

    console.log('sourceWeiWithDestinationDecimals', sourceWeiWithDestinationDecimals.toString())

    const sourceWei = convertDecimalValue(
      sourceWeiWithDestinationDecimals,
      this.destinationTokenDecimals,
      this.sourceTokenDecimals
    );

    console.log('sourceWei a', sourceWei.toString())

    return mulBigAndFixed(
      sourceWei,
      this.interchainGasPaymentEstimateMultiplier
    );
  }

  /**
   * Estimates the amount of gas required to prove and process a message.
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
   */
  async estimateDestinationGas() {
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

    console.log(
      'directHandleCallGas',
      directHandleCallGas,
      directHandleCallGas.toNumber(),
    );

    // directHandleCallGas includes the intrinsic gas
    return directHandleCallGas
      .add(this.inboxProvingAndProcessingGas)
      .add(this.destinationGasEstimateBuffer);
  }

  // Token prices

  get sourceTokenDecimals(): number {
    return this.core.getDomain(this.from)?.nativeTokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  }

  async sourceTokenPriceUsd(): Promise<FixedNumber> {
    return this.tokenPriceGetter.getNativeTokenUsdPrice(this.from);
  }

  get destinationTokenDecimals(): number {
    return this.core.getDomain(this.destination)?.nativeTokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  }

  async destinationTokenPriceUsd(): Promise<FixedNumber> {
    return this.tokenPriceGetter.getNativeTokenUsdPrice(this.destination);
  }

  // How many whole source tokens correspond to an amount of whole
  // destination tokens, calculated using their USD value.
  // Does not consider the decimals the tokens themselves have
  async sourceTokensPerDestinationToken(): Promise<FixedNumber> {
    const sourceUsd = await this.sourceTokenPriceUsd();
    const destUsd = await this.destinationTokenPriceUsd();

    // source = $10
    // dest = $1
    //
    // source decimals = 16
    // dest decimals = 10
    //
    // 10 / 1 => 0.1e18
    //
    // destination cost: 1e10 (one whole destination token)
    // 
    // should spend 0.1 * 1e16 then because:
    //   (dest usd) / (source usd) = 0.1
    //   (
    //     (destination gas cost wei) / (one whole destination token, 1e10)
    //   ) * (one whole source token, 1e16) = (1e10 / 1e10) * 1e16
    //
    // toSourceTokenDecimals:
    // if destDecimals == sourceDecimals:
    //    return destAmount
    // else if destDecimals > sourceDecimals:
    //    return destAmount / (10 ** (destDecimals - sourceDecimals))
    // else # if destDecimals < sourceDecimals
    //    return destAmount * (10 ** (sourceDecimals - destDecimals))

    return destUsd.divUnsafe(sourceUsd);
  }

  // Gas prices

  // In wei
  async suggestedDestinationGasPrice(): Promise<BigNumber> {
    const provider = this.core.mustGetProvider(this.destination);
    const suggestedGasPrice = await provider.getGasPrice();

    // suggestedGasPrice * destinationGasPriceMultiplier
    return mulBigAndFixed(suggestedGasPrice, this.destinationGasPriceMultiplier);
  }

  /**
   * A generous estimation of the gas consumption of all prove and process operations
   * in Inbox.sol, excluding:
   * 1. Intrinsic gas.
   * 2. Any gas consumed within a `handle` function when processing a message.
   */
  get inboxProvingAndProcessingGas() {
    // TODO: This does not consider that different domains are likely to have
    // different gas costs. Consider this being configurable for each domain, or
    // investigate ways to estimate this over RPC.
    return 120_000;
  }
}

function bigToFixed(fixed: BigNumber): FixedNumber {
  return FixedNumber.from(
    fixed.toString()
  );
}

function fixedToBig(fixed: FixedNumber, floor: boolean = false): BigNumber {
  const fixedAsInteger = floor ? fixed.floor() : fixed.ceiling();
  return BigNumber.from(
    fixedAsInteger.toFormat('fixed256x0').toString()
  )
}

function mulBigAndFixed(big: BigNumber, fixed: FixedNumber): BigNumber {
  return fixedToBig(
    fixed
      .mulUnsafe(
        bigToFixed(
          big
        )
      )
  );
}

function convertDecimalValue(value: BigNumber, fromDecimals: number, toDecimals: number): BigNumber {
  if (fromDecimals === toDecimals) {
    return value;
  } else if (fromDecimals > toDecimals) {
    return value.div(10 ** (fromDecimals - toDecimals));
  } else { // if (fromDecimals < toDecimals)
    return value.mul(10 ** (toDecimals - fromDecimals));
  }
}