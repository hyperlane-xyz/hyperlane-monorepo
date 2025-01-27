import {
    Address,
    beginCell,
    Builder,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    DictionaryKey,
    DictionaryValue,
    Sender,
    SendMode,
    Slice,
    TupleItemInt,
    TupleItemSlice,
} from '@ton/core';
import { OpCodes } from './utils/constants';
import { TGasConfig, THookMetadata } from './utils/types';
import { buildHookMetadataCell } from './utils/builders';

export type InterchainGasPaymasterConfig = {
    owner: Address;
    beneficiary: Address;
    hookType: number;
    hookMetadata: Cell;
    destGasConfig: Dictionary<number, TGasConfig>;
};

export function interchainGasPaymasterConfigToCell(config: InterchainGasPaymasterConfig): Cell {
    return beginCell()
        .storeAddress(config.owner)
        .storeAddress(config.beneficiary)
        .storeUint(config.hookType, 8)
        .storeRef(config.hookMetadata)
        .storeDict(config.destGasConfig)
        .endCell();
}

export class InterchainGasPaymaster implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static GasConfigKey: DictionaryKey<number> = Dictionary.Keys.Uint(32);
    static GasConfigValue: DictionaryValue<TGasConfig> = {
        serialize: (src: TGasConfig, builder: Builder) => {
            const transfer_cell = beginCell()
                .storeUint(src.gasOracle, 256)
                .storeUint(src.gasOverhead, 256)
                .storeUint(src.exchangeRate, 128)
                .storeUint(src.gasPrice, 128)
                .endCell();
            builder.storeRef(transfer_cell);
        },
        parse: (src: Slice): TGasConfig => {
            src = src.loadRef().beginParse();
            const data: TGasConfig = {
                gasOracle: src.loadUintBig(256),
                gasOverhead: src.loadUintBig(256),
                exchangeRate: src.loadUintBig(128),
                gasPrice: src.loadUintBig(128),
            };
            return data;
        },
    };

    static createFromAddress(address: Address) {
        return new InterchainGasPaymaster(address);
    }

    static createFromConfig(config: InterchainGasPaymasterConfig, code: Cell, workchain = 0) {
        const data = interchainGasPaymasterConfigToCell(config);
        const init = { code, data };
        return new InterchainGasPaymaster(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendPostDispatch(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            messageId: bigint;
            destDomain: number;
            refundAddr: Address;
            hookMetadata: THookMetadata;
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.POST_DISPATCH, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.messageId, 256)
                .storeUint(opts.destDomain, 32)
                .storeAddress(opts.refundAddr)
                .storeRef(buildHookMetadataCell(opts.hookMetadata))
                .endCell(),
        });
    }

    async sendQuoteDispatch(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            destDomain: number;
            hookMetadata: THookMetadata;
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.QUOTE_DISPATCH, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.destDomain, 32)
                .storeRef(buildHookMetadataCell(opts.hookMetadata))
                .endCell(),
        });
    }

    async sendTransferOwnership(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            ownerAddr: Address;
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.TRANSFER_OWNERSHIP, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.ownerAddr)
                .endCell(),
        });
    }

    async sendClaim(provider: ContractProvider, via: Sender, value: bigint, queryId?: number) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.CLAIM, 32)
                .storeUint(queryId ?? 0, 64)
                .endCell(),
        });
    }

    async sendSetDestGasConfig(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            destDomain: number;
            gasConfig: TGasConfig;
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.SET_DEST_GAS_CONFIG, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.destDomain, 32)
                .storeRef(
                    beginCell()
                        .storeUint(opts.gasConfig.gasOracle, 256)
                        .storeUint(opts.gasConfig.gasOverhead, 256)
                        .storeUint(opts.gasConfig.exchangeRate, 128)
                        .storeUint(opts.gasConfig.gasPrice, 128)
                        .endCell(),
                )
                .endCell(),
        });
    }

    async sendSetBeneficiary(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            beneficiaryAddr: Address;
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.SET_BENEFICIARY, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.beneficiaryAddr)
                .endCell(),
        });
    }

    async getExchangeRateAndGasPrice(provider: ContractProvider, destDomain: number) {
        const input: TupleItemInt = {
            type: 'int',
            value: BigInt(destDomain),
        };
        const result = await provider.get('get_exchange_rate_and_gas_price', [input]);
        return { exchangeRate: result.stack.readBigNumber(), gasPrice: result.stack.readBigNumber() };
    }

    async getHookType(provider: ContractProvider) {
        const result = await provider.get('get_hook_type', []);
        return result.stack.readNumber();
    }

    async getDestGasConfig(provider: ContractProvider) {
        const result = await provider.get('get_dest_gas_config', []);

        return Dictionary.loadDirect(
            InterchainGasPaymaster.GasConfigKey,
            InterchainGasPaymaster.GasConfigValue,
            result.stack.readCellOpt(),
        );
    }

    async getQuoteDispatch(provider: ContractProvider, destDomain: number, hookMetadata: THookMetadata) {
        const result = await provider.get('get_quote_dispatch', [
            {
                type: 'int',
                value: BigInt(destDomain),
            },
            {
                type: 'cell',
                cell: buildHookMetadataCell(hookMetadata),
            },
        ]);
        return result.stack.readBigNumber();
    }

    async getBeneficiary(provider: ContractProvider) {
        const result = await provider.get('get_beneficiary', []);
        return result.stack.readAddress();
    }

    async getOwner(provider: ContractProvider) {
        const result = await provider.get('get_owner', []);
        return result.stack.readAddress();
    }

    async getBalance(provider: ContractProvider) {
        return (await provider.getState()).balance;
    }
}
