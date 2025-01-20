import { NetworkProvider, compile } from '@ton/blueprint';
import { Address, Dictionary, beginCell, toNano } from '@ton/core';
import { ethers } from 'ethers';
import * as fs from 'fs';

import * as deployedContracts from '../deployedContracts.json';
import { ValidatorAnnounce } from '../wrappers/ValidatorAnnounce';

export async function run(provider: NetworkProvider) {
  const sampleWallet = new ethers.Wallet(process.env.ETH_WALLET_PUBKEY!);
  console.log(sampleWallet.address);
  const dict = Dictionary.empty(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Cell(),
  );

  console.log('domain', Number(process.env.DOMAIN!));
  console.log('version', Number(process.env.MAILBOX_VERSION!));
  console.log('validator', sampleWallet.address);

  const validatorAnnounce = provider.open(
    ValidatorAnnounce.createFromConfig(
      {
        localDomain: Number(process.env.DOMAIN!),
        // localDomain: 777002,
        mailbox: BigInt(
          '0x' +
            Address.parse(deployedContracts.mailboxAddress).hash.toString(
              'hex',
            ),
        ),
        // mailbox: BigInt('0x' + Address.parse('EQC5xrynw_llDS7czwH70rIeiblbn0rbtk-zjI8erKyIMTN6').hash.toString('hex')),
        // mailbox: BigInt('0x' + Address.parse('EQCqjMKRcYtuuucN4VirAd-DXrLc9DNTR1IWcaoNs2IMX7h8').hash.toString('hex')),
        storageLocations: dict,
        replayProtection: Dictionary.empty(
          Dictionary.Keys.BigUint(256),
          Dictionary.Values.Cell(),
        ),
      },
      await compile('ValidatorAnnounce'),
    ),
  );

  await validatorAnnounce.sendDeploy(provider.sender(), toNano('0.05'));

  await provider.waitForDeploy(validatorAnnounce.address);

  const data = {
    mailboxAddress: deployedContracts.mailboxAddress,
    interchainGasPaymasterAddress:
      deployedContracts.interchainGasPaymasterAddress,
    recipientAddress: deployedContracts.recipientAddress,
    multisigIsmAddress: deployedContracts.multisigIsmAddress,
    validatorAnnounceAddress: validatorAnnounce.address.toString(),
    merkleTreeHookAddress: deployedContracts.merkleTreeHookAddress,
  };

  fs.writeFileSync('./deployedContracts.json', JSON.stringify(data));
}
