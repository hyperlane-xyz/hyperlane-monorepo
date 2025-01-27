import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type MultisigIsmConfig = {};

export function multisigIsmConfigToCell(config: MultisigIsmConfig): Cell {
    return beginCell().endCell();
}

export class MockIsm implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new MockIsm(address);
    }

    static createFromConfig(config: MultisigIsmConfig, code: Cell, workchain = 0) {
        const data = multisigIsmConfigToCell(config);
        const init = { code, data };
        return new MockIsm(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }
}
