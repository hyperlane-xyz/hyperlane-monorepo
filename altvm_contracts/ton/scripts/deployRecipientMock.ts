import { NetworkProvider, compile } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import * as fs from 'fs';

import { RecipientMock } from '../wrappers/RecipientMock';

import { loadDeployedContracts } from './loadDeployedContracts';

export async function run(provider: NetworkProvider) {
  const domain = Number(process.env.ORIGIN_DOMAIN!);
  let deployedContracts = loadDeployedContracts(domain);
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
    interchainGasPaymasterAddress:
      deployedContracts.interchainGasPaymasterAddress,
    recipientAddress: recipientMock.address.toString(),
    multisigIsmAddress: deployedContracts.multisigIsmAddress,
    validatorAnnounceAddress: deployedContracts.validatorAnnounceAddress,
    merkleTreeHookAddress: deployedContracts.merkleTreeHookAddress,
  };

  fs.writeFileSync(`./deployedContracts_${domain}.json`, JSON.stringify(data));
}
