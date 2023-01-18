import { BigNumber } from 'ethers';

import { InterchainGasPaymaster__factory } from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import {
  CoreEnvironment,
  CoreEnvironmentChain,
  HyperlaneCore,
} from '../core/HyperlaneCore';
import { ChainNameToDomainId } from '../domains';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

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

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
    multiProvider: MultiProvider<CoreEnvironmentChain<Env>>,
  ): InterchainGasCalculator<CoreEnvironmentChain<Env>> {
    const core = HyperlaneCore.fromEnvironment(env, multiProvider);
    return new InterchainGasCalculator(multiProvider, core);
  }

  constructor(multiProvider: MultiProvider<Chain>, core: HyperlaneCore<Chain>) {
    this.multiProvider = multiProvider;
    this.core = core;
  }

  /**
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
  async quoteGasPayment<Destination extends Chain>(
    origin: Exclude<Chain, Destination>,
    destination: Destination,
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
  async quoteGasPaymentForIGP<Destination extends Chain>(
    origin: Exclude<Chain, Destination>,
    destination: Destination,
    gasAmount: BigNumber,
    interchainGasPaymasterAddress: types.Address,
  ): Promise<BigNumber> {
    const originProvider = this.multiProvider.getChainProvider(origin);
    const igp = InterchainGasPaymaster__factory.connect(
      interchainGasPaymasterAddress,
      originProvider,
    );
    return igp.quoteGasPayment(ChainNameToDomainId[destination], gasAmount);
  }
}
