import { Address, toNano } from '@ton/core';
import { RecipientMock } from '../wrappers/RecipientMock';
import { compile, NetworkProvider } from '@ton/blueprint';
import * as deployedContracts from '../deployedContracts.json';
import * as fs from 'fs';

export async function run(provider: NetworkProvider) {
    if (deployedContracts.multisigIsmAddress == '') {
        console.error('Aborted: deploy ism at first');
        return;
    }
    const recipientMock = provider.open(
        RecipientMock.createFromConfig(
            {
                ismAddr: Address.parse(deployedContracts.multisigIsmAddress),
            },
            await compile('RecipientMock'),
        ),
    );

    await recipientMock.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(recipientMock.address);

    const data = {
        mailboxAddress: deployedContracts.mailboxAddress,
        interchainGasPaymasterAddress: deployedContracts.interchainGasPaymasterAddress,
        recipientAddress: recipientMock.address.toString(),
        multisigIsmAddress: deployedContracts.multisigIsmAddress,
        validatorAnnounceAddress: deployedContracts.validatorAnnounceAddress,
    };

    fs.writeFileSync('./deployedContracts.json', JSON.stringify(data));
}
