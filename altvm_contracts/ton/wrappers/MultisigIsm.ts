import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    Sender,
    SendMode,
    TupleItemSlice,
} from '@ton/core';
import { OpCodes } from './utils/constants';
import { TMessage, TMultisigMetadata } from './utils/types';
import { buildMessageCell, buildMetadataCell, buildValidatorsDict } from './utils/builders';

export type MultisigIsmConfig = {
    moduleType: number;
    threshold: number;
    owner: Address;
    validators: Dictionary<bigint, Dictionary<bigint, bigint>>;
};

export function multisigIsmConfigToCell(config: MultisigIsmConfig): Cell {
    return beginCell()
        .storeUint(config.moduleType, 16)
        .storeUint(config.threshold, 8)
        .storeAddress(config.owner)
        .storeDict(config.validators)
        .storeDict(Dictionary.empty(Dictionary.Keys.Uint(256), Dictionary.Values.Cell()))
        .endCell();
}

export class MultisigIsm implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new MultisigIsm(address);
    }

    static createFromConfig(config: MultisigIsmConfig, code: Cell, workchain = 0) {
        const data = multisigIsmConfigToCell(config);
        const init = { code, data };
        return new MultisigIsm(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendVerify(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            message: TMessage;
            metadata: TMultisigMetadata;
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.VERIFY, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeRef(buildMessageCell(opts.message))
                .storeRef(buildMetadataCell(opts.metadata))
                .endCell(),
        });
    }

    async sendSetValidatorsAndThreshold(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            threshold: number;
            domain: number;
            validators: Dictionary<bigint, bigint>;
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.SET_VALIDATORS_AND_THRESHOLD, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.threshold, 8)
                .storeUint(opts.domain, 32)
                .storeDict(opts.validators)
                .endCell(),
        });
    }

    async getValidatorsAndThreshold(provider: ContractProvider, domain: number) {
        const result = await provider.get('get_validators_and_threshold', [
            {
                type: 'int',
                value: BigInt(domain),
            },
        ]);
        const threshold = result.stack.readBigNumber();
        let validators: bigint[] = [];
        const dict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(32),
            Dictionary.Values.BigUint(256),
            result.stack.readCellOpt(),
        );
        dict.keys().forEach((key) => {
            let val = dict.get(key);

            validators.push(val ?? 0n);
        });
        return {
            threshold,
            validators,
        };
    }
}
