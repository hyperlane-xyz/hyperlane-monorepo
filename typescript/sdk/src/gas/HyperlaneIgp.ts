import {InterchainGasPaymaster__factory} from "@hyperlane-xyz/core";
import {Address} from "@hyperlane-xyz/utils";

import {HyperlaneApp} from "../app/HyperlaneApp.js";
import {appFromAddressesMapHelper} from "../contracts/contracts.js";
import {HyperlaneAddressesMap} from "../contracts/types.js";
import {MultiProvider} from "../providers/MultiProvider.js";
import {ChainName} from "../types.js";

import {IgpFactories, igpFactories} from "./contracts.js";

type InterchainGasPaymasterContract = Awaited<
    ReturnType<InterchainGasPaymaster__factory["deploy"]>
>;
type GasAmount = Parameters<
    InterchainGasPaymasterContract["quoteGasPayment"]
>[1];
type GasPaymentQuote = Awaited<
    ReturnType<InterchainGasPaymasterContract["quoteGasPayment"]>
>;

export class HyperlaneIgp extends HyperlaneApp<IgpFactories> {
    static fromAddressesMap(
        addressesMap: HyperlaneAddressesMap<any>,
        multiProvider: MultiProvider,
    ): HyperlaneIgp {
        const helper = appFromAddressesMapHelper(
            addressesMap,
            igpFactories,
            multiProvider,
        );
        return new HyperlaneIgp(helper.contractsMap, helper.multiProvider);
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
    quoteGasPayment(
        origin: ChainName,
        destination: ChainName,
        gasAmount: GasAmount,
    ): Promise<GasPaymentQuote> {
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
    quoteGasPaymentForDefaultIsmIgp(
        origin: ChainName,
        destination: ChainName,
        gasAmount: GasAmount,
    ): Promise<GasPaymentQuote> {
        const igp = this.getContracts(origin).interchainGasPaymaster;
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
    protected quoteGasPaymentForIgp(
        origin: ChainName,
        destination: ChainName,
        gasAmount: GasAmount,
        interchainGasPaymasterAddress: Address,
    ): Promise<GasPaymentQuote> {
        const originProvider = this.multiProvider.getProvider(origin);
        const igp = InterchainGasPaymaster__factory.connect(
            interchainGasPaymasterAddress,
            originProvider,
        );
        const domainId = this.multiProvider.getDomainId(destination);
        return igp.quoteGasPayment(domainId, gasAmount);
    }
}
