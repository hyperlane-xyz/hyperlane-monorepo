import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { THookMetadata } from './utils/types';
import { OpCodes } from './utils/constants';
import { buildHookMetadataCell } from './utils/builders';

export type MerkleHookMockConfig = {
    index: number;
};

export function merkleHookMockConfigToCell(config: MerkleHookMockConfig): Cell {
    return beginCell().storeUint(config.index, 32).endCell();
}

export class MerkleHookMock implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new MerkleHookMock(address);
    }

    static createFromConfig(config: MerkleHookMockConfig, code: Cell, workchain = 0) {
        const data = merkleHookMockConfigToCell(config);
        const init = { code, data };
        return new MerkleHookMock(contractAddress(workchain, init), init);
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

    async getCount(provider: ContractProvider) {
        const result = await provider.get('get_count', []);
        return result.stack.readNumber();
    }

    async getLatestCheckpoint(provider: ContractProvider) {
        const result = await provider.get('get_latest_checkpoint', []);
        const root = result.stack.readNumber();
        const index = result.stack.readNumber();
        return { root, index };
    }
}
