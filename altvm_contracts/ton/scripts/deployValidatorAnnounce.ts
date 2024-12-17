import { Address, beginCell, Dictionary, toNano } from '@ton/core';
import { ValidatorAnnounce } from '../wrappers/ValidatorAnnounce';
import { compile, NetworkProvider } from '@ton/blueprint';
import * as deployedContracts from '../deployedContracts.json';
import { ethers } from 'ethers';
import * as fs from 'fs';

export async function run(provider: NetworkProvider) {
    const sampleWallet = new ethers.Wallet(process.env.ETH_WALLET_PUBKEY!);
    console.log(sampleWallet.address);
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());

    console.log('domain', Number(process.env.DOMAIN!));
    console.log('version', Number(process.env.MAILBOX_VERSION!));
    console.log('validator', sampleWallet.address);

    const validatorAnnounce = provider.open(
        ValidatorAnnounce.createFromConfig(
            {
                localDomain: Number(process.env.DOMAIN!),
                mailbox: BigInt('0x' + Address.parse(deployedContracts.mailboxAddress).hash.toString('hex')),
                storageLocations: dict,
                replayProtection: Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()),
            },
            await compile('ValidatorAnnounce'),
        ),
    );

    await validatorAnnounce.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(validatorAnnounce.address);

    const data = {
        mailboxAddress: deployedContracts.mailboxAddress,
        interchainGasPaymasterAddress: deployedContracts.interchainGasPaymasterAddress,
        recipientAddress: deployedContracts.recipientAddress,
        multisigIsmAddress: deployedContracts.multisigIsmAddress,
        validatorAnnounceAddress: validatorAnnounce.address.toString(),
    };

    fs.writeFileSync('./deployedContracts.json', JSON.stringify(data));
}
