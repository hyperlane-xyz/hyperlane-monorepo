import type {Address} from "@hyperlane-xyz/utils";

import type {ChainMap} from "../types.js";

export type AddressesMap = {
    [key: string]: Address;
};

export type HyperlaneContractFactory = {
    deploy: (...args: any[]) => Promise<any>;
    attach: (address: Address) => any;
    connect: (connection: any) => any;
};

export type HyperlaneFactories = {
    [key: string]: HyperlaneContractFactory;
};

export type HyperlaneContracts<F extends HyperlaneFactories> = {
    [P in keyof F]: Awaited<ReturnType<F[P]["deploy"]>>;
};

export type HyperlaneContractsMap<F extends HyperlaneFactories> = ChainMap<
    HyperlaneContracts<F>
>;

export type HyperlaneAddresses<F extends HyperlaneFactories> = {
    [P in keyof F]: Address;
};

export type HyperlaneAddressesMap<F extends HyperlaneFactories> = ChainMap<
    HyperlaneAddresses<F>
>;
