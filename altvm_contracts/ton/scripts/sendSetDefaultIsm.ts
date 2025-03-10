import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import * as fs from 'fs';
import * as path from 'path';

import { Mailbox } from '../wrappers/Mailbox';

import { loadDeployedContracts } from './utils';

export async function run(provider: NetworkProvider) {
  const domain = Number(process.env.ORIGIN_DOMAIN) || 0;

  let deployedContracts = loadDeployedContracts(domain);
  const mailbox = provider.open(
    Mailbox.createFromAddress(Address.parse(deployedContracts.mailboxAddress)),
  );

  console.log('mailbox address:', deployedContracts.mailboxAddress);

  await mailbox.sendSetDefaultIsm(provider.sender(), toNano('0.1'), {
    defaultIsmAddr: Address.parse(deployedContracts.multisigIsmAddress),
  });
}
