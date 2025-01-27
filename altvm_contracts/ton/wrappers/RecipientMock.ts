import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type RecipientMockConfig = {
    ismAddr: Address;
};

export function recipientMockConfigToCell(config: RecipientMockConfig): Cell {
    return beginCell().storeAddress(config.ismAddr).endCell();
}

export class RecipientMock implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new RecipientMock(address);
    }

    static createFromConfig(config: RecipientMockConfig, code: Cell, workchain = 0) {
        const data = recipientMockConfigToCell(config);
        const init = { code, data };
        return new RecipientMock(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }
}
