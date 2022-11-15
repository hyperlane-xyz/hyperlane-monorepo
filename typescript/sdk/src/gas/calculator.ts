import CoinGecko from 'coingecko-api';
import { BigNumber, FixedNumber, ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata';
import {
  CoreEnvironment,
  CoreEnvironmentChain,
  HyperlaneCore,
} from '../core/HyperlaneCore';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName, Remotes } from '../types';
import { convertDecimalValue, mulBigAndFixed } from '../utils/number';

import { CoinGeckoTokenPriceGetter, TokenPriceGetter } from './token-prices';

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

// Intrinsic gas for a transaction. Does not consider calldata costs or differences in
// intrinsic gas for different chains.
const GAS_INTRINSIC = 21_000;

// The gas used to process a message when the quorum size is zero.
// Includes intrinsic gas and all other gas that does not scale with the
// quorum size. Excludes the cost of calling `recipient.handle()`.
// Derived by observing the amount of gas consumed for a quorum of 1 (~103000 gas),
// and subtracting the gas overhead per signature.
const GAS_OVERHEAD_BASE = 95_000;

// The amount of gas used for each signature when a signed checkpoint
// is submitted for verification.
// Really observed to be about 8568, but rounding up for safety.
const GAS_OVERHEAD_PER_SIGNATURE = 9_000;

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
  private core: HyperlaneCore<Chain>;
  private multiProvider: MultiProvider<Chain>;

  private tokenPriceGetter: TokenPriceGetter;

  private paymentEstimateMultiplier: ethers.FixedNumber;
  private messageGasEstimateBuffer: ethers.BigNumber;

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
    multiProvider: MultiProvider<CoreEnvironmentChain<Env>>,
    config?: InterchainGasCalculatorConfig,
  ): InterchainGasCalculator<CoreEnvironmentChain<Env>> {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    return new InterchainGasCalculator(multiProvider, core, config);
  }

  constructor(
    multiProvider: MultiProvider<Chain>,
    core: HyperlaneCore<Chain>,
    config?: InterchainGasCalculatorConfig,
  ) {
    this.multiProvider = multiProvider;
    this.core = core;

    if (config?.tokenPriceGetter) {
      this.tokenPriceGetter = config.tokenPriceGetter;
    } else {
      const coinGecko = new CoinGecko();
      this.tokenPriceGetter = new CoinGeckoTokenPriceGetter(coinGecko);
    }

    this.paymentEstimateMultiplier = FixedNumber.from(
      config?.paymentEstimateMultiplier ?? '1.25',
    );
    this.messageGasEstimateBuffer = BigNumber.from(
      config?.messageGasEstimateBuffer ?? 50_000,
    );
  }

  /**
   * Given an amount of gas to consume on the destination chain, calculates the
   * estimated payment denominated in the native token of the origin chain.
   * Considers the exchange rate between the native tokens of the origin and
   * destination chains and the suggested gas price of the destination chain.
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param gas The amount of gas to pay for on the destination chain.
   * @returns An estimated amount of origin chain tokens to cover gas costs on the
   * destination chain.
   */
  async estimatePaymentForGas<Destination extends Chain>(
    origin: Exclude<Chain, Destination>,
    destination: Destination,
    gas: BigNumber,
  ): Promise<BigNumber> {
    const destinationGasPrice = await this.getGasPrice(destination);
    const destinationGasCost = gas.mul(destinationGasPrice);
    const originGasCost = await this.convertBetweenTokens(
      destination,
      origin,
      destinationGasCost,
    );
    // Applies a multiplier
    return mulBigAndFixed(
      originGasCost,
      this.paymentEstimateMultiplier,
      true, // ceil
    );
  }

  /**
   * Given an amount of gas the message's recipient `handle` function is expected
   * to use, calculates the estimated payment denominated in the native
   * token of the origin chain. Considers the exchange rate between the native
   * tokens of the origin and destination chains, the suggested gas price on
   * the destination chain, gas costs incurred by a relayer when submitting a signed
   * checkpoint to the destination chain, and the overhead gas cost in Inbox of processing
   * a message.
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param handleGas The amount of gas the recipient `handle` function
   * is estimated to use.
   * @returns An estimated amount of origin chain tokens to cover gas costs of the
   * message on the destination chain.
   */
  async estimatePaymentForHandleGas<Destination extends Chain>(
    origin: Exclude<Chain, Destination>,
    destination: Destination,
    handleGas: BigNumber,
  ): Promise<BigNumber> {
    const destinationGas = handleGas.add(
      await this.estimateGasForProcess(origin, destination),
    );
    return this.estimatePaymentForGas(origin, destination, destinationGas);
  }

  /**
   * Calculates the estimated payment to process the message on its destination chain,
   * denominated in the native token of the origin chain. The gas used by the message's
   * recipient handler function is estimated in an eth_estimateGas call to the
   * destination chain, and is then used to calculate the payment using
   * Currently made private as it does not work properly for Arbitrum.
   * {@link estimatePaymentForHandleGasAmount}.
   * @param message The parsed message to estimate payment for.
   * @returns An estimated amount of origin chain tokens to cover gas costs of the
   * message on the destination chain.
   */
  protected async estimatePaymentForMessage<Destination extends Chain>(
    message: ParsedMessage<Chain, Destination>,
  ): Promise<BigNumber> {
    const handleGas = await this.estimateGasForHandle(message);
    return this.estimatePaymentForHandleGas(
      message.origin,
      message.destination,
      handleGas,
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
  protected async convertBetweenTokens(
    fromChain: Chain,
    toChain: Chain,
    value: BigNumber,
  ): Promise<BigNumber> {
    // Does not factor in differing token decimals.
    const exchangeRate = await this.tokenPriceGetter.getTokenExchangeRate(
      fromChain,
      toChain,
    );

    // 1/100th of a cent
    const PRECISION = 1000;

    return convertDecimalValue(
      value.mul(Math.round(exchangeRate * PRECISION)).div(PRECISION),
      this.tokenDecimals(fromChain),
      this.tokenDecimals(toChain),
    );
  }

  /**
   * Gets a suggested gas price for a chain.
   * @param chainName The name of the chain to get the gas price for
   * @returns The suggested gas price in wei on the destination chain.
   */
  protected async getGasPrice(chain: Chain): Promise<BigNumber> {
    const provider = this.multiProvider.getChainConnection(chain).provider!;
    if (provider == undefined) {
      throw new Error(`Missing provider for ${chain}`);
    }
    return provider.getGasPrice();
  }

  /**
   * Gets the number of decimals of the provided chain's native token.
   * @param chain The chain.
   * @returns The number of decimals of `chain`'s native token.
   */
  protected tokenDecimals(chain: Chain): number {
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
  protected async estimateGasForHandle<LocalChain extends Chain>(
    message: ParsedMessage<Chain, LocalChain>,
  ): Promise<BigNumber> {
    const provider = this.multiProvider.getChainConnection(message.destination)
      .provider!;

    const mailbox = this.core.getContracts(message.destination).mailbox
      .contract;

    const handlerInterface = new ethers.utils.Interface([
      'function handle(uint32,bytes32,bytes)',
    ]);
    // Estimates a direct call to the `handle` function of the recipient
    // with the `from` address set to the inbox.
    // This includes intrinsic gas.
    const directHandleCallGas = await provider.estimateGas({
      to: utils.bytes32ToAddress(message.recipient),
      from: mailbox.address,
      data: handlerInterface.encodeFunctionData('handle', [
        chainMetadata[message.origin].id,
        utils.addressToBytes32(message.sender),
        message.body,
      ]),
    });

    // Subtract intrinsic gas, which is included in directHandleCallGas.
    // Note the "real" intrinsic gas will always be higher than this.intrinsicGas
    // due to calldata costs, but this is desired because subtracting the lower bound
    // this.intrinsicGas will result in a more generous final estimate.
    return directHandleCallGas
      .add(this.messageGasEstimateBuffer)
      .sub(this.intrinsicGas());
  }

  /**
   * @returns A generous estimation of the gas consumption of all process
   * operations within Inbox.sol, including intrinsic gas. Does not include any gas
   * consumed within a message's recipient `handle` function.
   */
  protected async estimateGasForProcess<Destination extends Chain>(
    origin: Remotes<Chain, Destination>,
    destination: Destination,
  ): Promise<BigNumber> {
    // TODO: Check the recipient module
    const module = this.core.getContracts(destination).multisigIsm;
    const threshold = await module.threshold(origin);
    return threshold.mul(GAS_OVERHEAD_PER_SIGNATURE).add(GAS_OVERHEAD_BASE);
  }

  /**
   * @returns The intrinsic gas of a basic transaction. Note this does not consider calldata
   * costs or potentially different intrinsic gas costs for different chains.
   */
  protected intrinsicGas(): BigNumber {
    return BigNumber.from(GAS_INTRINSIC);
  }
}
