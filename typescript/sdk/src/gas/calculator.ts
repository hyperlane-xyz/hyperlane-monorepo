import CoinGecko from 'coingecko-api';
import { BigNumber, FixedNumber, ethers } from 'ethers';

import { InterchainGasPaymaster__factory } from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { CoreEnvironment, HyperlaneCore } from '../core/HyperlaneCore';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';
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
// Includes intrinsic gas, mailbox overhead gas, all other gas that does not scale with the
// quorum size. Excludes the cost of the recipient's handle function.
const GAS_OVERHEAD_BASE = 155_000;

// The amount of gas used for each signature when a signed checkpoint
// is submitted for verification.
// Really observed to be about 6500, but rounding up for safety.
const GAS_OVERHEAD_PER_SIGNATURE = 7_500;

export interface InterchainGasCalculatorConfig {
  /**
   * A multiplier applied to the estimated origin token payment amount.
   * This should be high enough to account for movements in token exchange
   * rates and gas prices.
   * Only used for gas payment estimates that are not quoted on-chain.
   * @defaultValue 1.25
   */
  paymentEstimateMultiplier?: string;
  /**
   * An amount of additional gas to add to the estimated gas of processing a message.
   * Only used when estimating a payment from a message.
   * Only used for gas payment estimates that are not quoted on-chain.
   * @defaultValue 50,000
   */
  messageGasEstimateBuffer?: string;
  /**
   * Used to get the native token prices of the origin and destination chains.
   * Only used for gas payment estimates that are not quoted on-chain.
   * @defaultValue An instance of DefaultTokenPriceGetter.
   */
  tokenPriceGetter?: TokenPriceGetter;
}

export interface ParsedMessage {
  origin: ChainName;
  sender: string;
  destination: ChainName;
  recipient: string;
  body: string;
}

/**
 * Calculates interchain gas payments.
 */
export class InterchainGasCalculator {
  private core: HyperlaneCore;
  private multiProvider: MultiProvider;

  private tokenPriceGetter: TokenPriceGetter;

  private paymentEstimateMultiplier: ethers.FixedNumber;
  private messageGasEstimateBuffer: ethers.BigNumber;

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
    config?: InterchainGasCalculatorConfig,
  ): InterchainGasCalculator {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    return new InterchainGasCalculator(multiProvider, core, config);
  }

  constructor(
    multiProvider: MultiProvider,
    core: HyperlaneCore,
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
   * Only intended for IGPs that quote gas payments on-chain.
   * Calls the default ISM IGP's `quoteGasPayment` function to get the amount of native tokens
   * required to pay for interchain gas.
   * The default ISM IGP will add any gas overhead amounts related to the Mailbox
   * and default ISM on the destination to the provided gasAmount.
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param gasAmount The amount of gas to use when calling `quoteGasPayment`.
   * The default IGP is expected to add any gas overhead related to the Mailbox
   * or ISM, so this gas amount is only required to cover the usage of the `handle`
   * function.
   * @returns The amount of native tokens required to pay for interchain gas.
   */
  async quoteGasPaymentForDefaultIsmIgp(
    origin: ChainName,
    destination: ChainName,
    gasAmount: BigNumber,
  ): Promise<BigNumber> {
    const igpAddress =
      this.core.getContracts(origin).defaultIsmInterchainGasPaymaster;
    return this.quoteGasPaymentForIGP(
      origin,
      destination,
      gasAmount,
      igpAddress.address,
    );
  }

  /**
   * Only intended for IGPs that quote gas payments on-chain.
   * Calls the "base" IGP's `quoteGasPayment` function to get the amount of native tokens
   * required to pay for interchain gas.
   * This IGP will not apply any overhead gas to the provided gasAmount.
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param gasAmount The amount of gas to use when calling `quoteGasPayment`.
   * This is expected to be the total amount of gas that a transaction would use
   * on the destination chain. This should consider intrinsic transaction gas,
   * Mailbox overhead gas costs, ISM gas costs, and the recipient's handle function
   * gas cost.
   * @returns The amount of native tokens required to pay for interchain gas.
   */
  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
    gasAmount: BigNumber,
  ): Promise<BigNumber> {
    const igpAddress = this.core.getContracts(origin).interchainGasPaymaster;
    return this.quoteGasPaymentForIGP(
      origin,
      destination,
      gasAmount,
      igpAddress.address,
    );
  }

  /**
   * Only intended for IGPs that quote gas payments on-chain.
   * Calls the origin's default IGP's `quoteGasPayment` function to get the
   * amount of native tokens required to pay for interchain gas.
   * The default IGP is expected to add any gas overhead related to the Mailbox
   * and ISM to the provided gasAmount.
   * @param origin The name of the origin chain.
   * @param destination The name of the destination chain.
   * @param gasAmount The amount of gas to use when calling `quoteGasPayment`.
   * The default IGP is expected to add any gas overhead related to the Mailbox
   * or ISM, so this gas amount is only required to cover the usage of the `handle`
   * function.
   * @returns The amount of native tokens required to pay for interchain gas.
   */
  async quoteGasPaymentForIGP(
    origin: ChainName,
    destination: ChainName,
    gasAmount: BigNumber,
    interchainGasPaymasterAddress: types.Address,
  ): Promise<BigNumber> {
    const originProvider = this.multiProvider.getProvider(origin);
    const igp = InterchainGasPaymaster__factory.connect(
      interchainGasPaymasterAddress,
      originProvider,
    );
    const domainId = this.multiProvider.getDomainId(destination);
    return igp.quoteGasPayment(domainId, gasAmount);
  }

  /**
   * Only intended for IGPs that do *not* quote gas payments on-chain.
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
  async estimatePaymentForGas(
    origin: ChainName,
    destination: ChainName,
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
   * Only intended for IGPs that do *not* quote gas payments on-chain.
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
  async estimatePaymentForHandleGas(
    origin: ChainName,
    destination: ChainName,
    handleGas: BigNumber,
  ): Promise<BigNumber> {
    const destinationGas = handleGas.add(
      await this.estimateGasForProcess(origin, destination),
    );
    return this.estimatePaymentForGas(origin, destination, destinationGas);
  }

  /**
   * Only intended for IGPs that do *not* quote gas payments on-chain.
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
  protected async estimatePaymentForMessage(
    message: ParsedMessage,
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
    fromChain: ChainName,
    toChain: ChainName,
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
  protected async getGasPrice(chain: ChainName): Promise<BigNumber> {
    const provider = this.multiProvider.getProvider(chain);
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
  protected tokenDecimals(chain: ChainName): number {
    return (
      this.multiProvider.tryGetChainMetadata(chain)?.nativeToken?.decimals ??
      DEFAULT_TOKEN_DECIMALS
    );
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
  protected async estimateGasForHandle(
    message: ParsedMessage,
  ): Promise<BigNumber> {
    const provider = this.multiProvider.getProvider(message.destination);

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
        this.multiProvider.getChainId(message.origin),
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
  protected async estimateGasForProcess(
    origin: ChainName,
    destination: ChainName,
  ): Promise<BigNumber> {
    // TODO: Check the recipient module
    const module = this.core.getContracts(destination).multisigIsm;
    const threshold = await module.threshold(
      this.multiProvider.getDomainId(origin),
    );
    return BigNumber.from(threshold)
      .mul(GAS_OVERHEAD_PER_SIGNATURE)
      .add(GAS_OVERHEAD_BASE);
  }

  /**
   * @returns The intrinsic gas of a basic transaction. Note this does not consider calldata
   * costs or potentially different intrinsic gas costs for different chains.
   */
  protected intrinsicGas(): BigNumber {
    return BigNumber.from(GAS_INTRINSIC);
  }
}
