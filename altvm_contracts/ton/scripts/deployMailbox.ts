import { NetworkProvider, compile } from '@ton/blueprint';
import { Address, Cell, Dictionary, toNano } from '@ton/core';
import * as fs from 'fs';

import { Mailbox } from '../wrappers/Mailbox';
import {
  TMailboxContractConfig,
  TProcessRequest,
} from '../wrappers/utils/types';

import { loadDeployedContracts } from './loadDeployedContracts';

export async function run(provider: NetworkProvider) {
  const domain = Number(process.env.ORIGIN_DOMAIN!);
  const deployedContracts = loadDeployedContracts(domain);
  if (
    deployedContracts.multisigIsmAddress === '' ||
    deployedContracts.interchainGasPaymasterAddress === '' ||
    deployedContracts.merkleTreeHookAddress === ''
  ) {
    console.error('Aborted: deploy ism and hook contracts at first');
    return;
  }
  const version = Number(process.env.MAILBOX_VERSION!);

  console.log('domain', domain);
  console.log('version', version);

  const deliveryCode = await compile('Delivery');

  const config: TMailboxContractConfig = {
    version,
    localDomain: domain,
    nonce: 0,
    latestDispatchedId: 0n,
    defaultIsm: Address.parse(deployedContracts.multisigIsmAddress),
    defaultHookAddr: deployedContracts.merkleTreeHookAddress
      ? Address.parse(deployedContracts.merkleTreeHookAddress)
      : Address.parse(
          '0:0000000000000000000000000000000000000000000000000000000000000000',
        ),
    requiredHookAddr: Address.parse(
      deployedContracts.interchainGasPaymasterAddress,
    ),
    deliveryCode,
    processRequests: Dictionary.empty(
      Mailbox.DeliveryKey,
      Mailbox.DeliveryValue,
    ),
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

  fs.writeFileSync(`./deployedContracts_${domain}.json`, JSON.stringify(data));
}
