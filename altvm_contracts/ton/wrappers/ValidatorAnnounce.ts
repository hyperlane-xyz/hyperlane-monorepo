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
    Slice,
} from '@ton/core';
import { OpCodes } from './utils/constants';
import { TSignature } from './utils/types';
import { buildSignatureCell } from './utils/builders';

export type ValidatorAnnounceConfig = {
    localDomain: number;
    mailbox: bigint;
    storageLocations: Dictionary<bigint, Cell>;
    replayProtection: Dictionary<bigint, Cell>;
};

export function validatorAnnounceConfigToCell(config: ValidatorAnnounceConfig): Cell {
    return beginCell()
        .storeUint(config.localDomain, 32)
        .storeUint(config.mailbox, 256)
        .storeDict(config.storageLocations)
        .storeDict(config.replayProtection)
        .endCell();
}

export class ValidatorAnnounce implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new ValidatorAnnounce(address);
    }

    static createFromConfig(config: ValidatorAnnounceConfig, code: Cell, workchain = 0) {
        const data = validatorAnnounceConfigToCell(config);
        const init = { code, data };
        return new ValidatorAnnounce(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendAnnounce(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            validatorAddr: bigint;
            signature: TSignature;
            storageLocation: Slice;
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OpCodes.ANNOUNCE, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.validatorAddr, 256)
                .storeRef(beginCell().storeSlice(opts.storageLocation).endCell())
                .storeRef(buildSignatureCell(opts.signature))
                .endCell(),
        });
    }

    async getAnnouncedStorageLocations(provider: ContractProvider, input: Cell) {
        const result = await provider.get('get_announced_storage_locations', [
            {
                type: 'cell',
                cell: input,
            },
        ]);
        const dict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.Cell(),
            result.stack.readCellOpt(),
        );
        const map = new Map<bigint, string[]>();
        dict.keys().forEach((key) => {
            let val = dict.get(key);
            const subDict = Dictionary.loadDirect(
                Dictionary.Keys.BigInt(256),
                Dictionary.Values.Cell(),
                val ?? Cell.EMPTY,
            );
            let storageLocations: string[] = [];
            subDict.values().forEach((value) => {
                storageLocations.push(value.beginParse().loadStringTail());
            });
            map.set(key, storageLocations);
        });
        return map;
    }
}
