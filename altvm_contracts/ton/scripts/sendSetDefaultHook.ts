import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

import { Mailbox } from '../wrappers/Mailbox';

function loadDeployedContracts(domain: number) {
  const filePath = path.join(__dirname, `../deployedContracts_${domain}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployed contracts file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export async function run(provider: NetworkProvider) {
  const domain = Number(process.env.ORIGIN_DOMAIN) || 0;

  let deployedContracts = loadDeployedContracts(domain);
  const mailbox = provider.open(
    Mailbox.createFromAddress(Address.parse(deployedContracts.mailboxAddress)),
  );

  console.log('mailbox address:', deployedContracts.mailboxAddress);

  await mailbox.sendSetDefaultHook(provider.sender(), toNano('0.1'), {
    defaultHookAddr: Address.parse(deployedContracts.merkleTreeHookAddress),
  });
}
