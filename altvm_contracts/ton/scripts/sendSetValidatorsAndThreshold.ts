import { NetworkProvider } from '@ton/blueprint';
import { buildValidatorsDict } from '../wrappers/utils/builders';
import { MultisigIsm } from '../wrappers/MultisigIsm';
import { Address, toNano } from '@ton/core';
import * as deployedContracts from '../deployedContracts.json';
import { ethers } from 'ethers';

export async function run(provider: NetworkProvider) {
    const sampleWallet = new ethers.Wallet(process.env.ETH_WALLET_PUBKEY!);

    const multisigIsm = provider.open(
        MultisigIsm.createFromAddress(Address.parse(deployedContracts.multisigIsmAddress)),
    );

    console.log('msig address:', multisigIsm.address);

    await multisigIsm.sendSetValidatorsAndThreshold(provider.sender(), toNano('0.1'), {
        threshold: 1,
        domain: 777002,
        validators: buildValidatorsDict([BigInt(sampleWallet.address)]),
    });
}
