import { NetworkProvider, compile } from '@ton/blueprint';
import { Address, Cell, Dictionary, toNano } from '@ton/core';
import * as fs from 'fs';

import * as deployedContracts from '../deployedContracts.json';
import { Mailbox } from '../wrappers/Mailbox';
import { TDelivery, TMailboxContractConfig } from '../wrappers/utils/types';

export async function run(provider: NetworkProvider) {
  if (
    deployedContracts.multisigIsmAddress === '' ||
    deployedContracts.interchainGasPaymasterAddress === '' ||
    deployedContracts.merkleTreeHookAddress === ''
  ) {
    console.error('Aborted: deploy ism and igp contracts at first');
    return;
  }

  console.log('domain', Number(process.env.DOMAIN!));
  console.log('version', Number(process.env.MAILBOX_VERSION!));

  const config: TMailboxContractConfig = {
    version: Number(process.env.MAILBOX_VERSION!),
    localDomain: Number(process.env.DOMAIN!),
    nonce: 0,
    latestDispatchedId: 0n,
    defaultIsm: Address.parse(deployedContracts.multisigIsmAddress),
    defaultHookAddr: Address.parse(deployedContracts.merkleTreeHookAddress),
    requiredHookAddr: Address.parse(
      deployedContracts.interchainGasPaymasterAddress,
    ),
    deliveries: Dictionary.empty(Mailbox.DeliveryKey, Mailbox.DeliveryValue),
    owner: Address.parse(process.env.MAILBOX_OWNER_ADDRESS!),
  };

  const mailbox = provider.open(
    Mailbox.createFromConfig(config, await compile('Mailbox')),
  );

  await mailbox.sendDeploy(provider.sender(), toNano('0.05'));

  await provider.waitForDeploy(mailbox.address);

  const data = {
    mailboxAddress: mailbox.address.toString(),
    interchainGasPaymasterAddress:
      deployedContracts.interchainGasPaymasterAddress,
    recipientAddress: deployedContracts.recipientAddress,
    multisigIsmAddress: deployedContracts.multisigIsmAddress,
    validatorAnnounceAddress: deployedContracts.validatorAnnounceAddress,
    merkleTreeHookAddress: deployedContracts.merkleTreeHookAddress,
  };

  fs.writeFileSync('./deployedContracts.json', JSON.stringify(data));
}
