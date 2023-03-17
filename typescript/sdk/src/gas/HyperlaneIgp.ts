import { BigNumber } from 'ethers';

import { InterchainGasPaymaster__factory } from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { hyperlaneEnvironments } from '../consts/environments';
import { HyperlaneAddresses } from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { IgpContracts, igpFactories } from './contracts';

export type IgpEnvironment = keyof typeof hyperlaneEnvironments;
export type IgpEnvironmentChain<E extends IgpEnvironment> = Extract<
  keyof typeof hyperlaneEnvironments[E],
  ChainName
>;

export type IgpContractsMap = {
  [chain: ChainName]: IgpContracts;
};

export class HyperlaneIgp extends HyperlaneApp<IgpContracts> {
  constructor(contractsMap: IgpContractsMap, multiProvider: MultiProvider) {
    super(contractsMap, multiProvider);
  }

  static fromAddresses(
    addresses: ChainMap<HyperlaneAddresses>,
    multiProvider: MultiProvider,
  ): HyperlaneIgp {
    const { contracts, intersectionProvider } =
      this.buildContracts<IgpContracts>(addresses, igpFactories, multiProvider);
    return new HyperlaneIgp(contracts, intersectionProvider);
  }

  static fromEnvironment<Env extends IgpEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): HyperlaneIgp {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    return HyperlaneIgp.fromAddresses(envAddresses, multiProvider);
  }

  getContracts(chain: ChainName): IgpContracts {
    return super.getContracts(chain);
  }

  /**
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
  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
    gasAmount: BigNumber,
  ): Promise<BigNumber> {
    const igp = this.getContracts(origin).interchainGasPaymaster;
    return this.quoteGasPaymentForIgp(
      origin,
      destination,
      gasAmount,
      igp.address,
    );
  }

  /**
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
    const igp = this.getContracts(origin).defaultIsmInterchainGasPaymaster;
    return this.quoteGasPaymentForIgp(
      origin,
      destination,
      gasAmount,
      igp.address,
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
  protected async quoteGasPaymentForIgp(
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
}
