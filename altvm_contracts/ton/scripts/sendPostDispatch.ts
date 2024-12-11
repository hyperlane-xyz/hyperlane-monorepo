import { toNano, Address, beginCell } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { TMessage, THookMetadata } from '../wrappers/utils/types';
import * as deployedContracts from '../deployedContracts.json';
import { InterchainGasPaymaster } from '../wrappers/InterchainGasPaymaster';
import { messageId } from '../tests/utils/signing';

export async function run(provider: NetworkProvider) {
    console.log('igp:', deployedContracts.interchainGasPaymasterAddress);
    const recipient = Address.parse(deployedContracts.recipientAddress).hash;
    console.log('recipient:', recipient);

    const message: TMessage = {
        version: 1,
        nonce: 2,
        origin: 0,
        sender: Buffer.alloc(32),
        destinationDomain: 0,
        recipient,
        body: beginCell().storeUint(123, 32).endCell(),
    };

    const hookMetadata: THookMetadata = {
        variant: 0,
        msgValue: 1000n,
        gasLimit: 50000n,
        refundAddress: Address.parse(process.env.TON_ADDRESS!),
    };

    const igp = provider.open(
        InterchainGasPaymaster.createFromAddress(Address.parse(deployedContracts.interchainGasPaymasterAddress)),
    );

    console.log('ton address:', process.env.TON_ADDRESS!);

    await igp.sendPostDispatch(provider.sender(), toNano('0.1'), {
        messageId: BigInt(messageId(message)),
        destDomain: message.destinationDomain,
        refundAddr: Address.parse(process.env.TON_ADDRESS!),
        hookMetadata,
    });
}
