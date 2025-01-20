import { NetworkProvider } from '@ton/blueprint';
import { Address, beginCell, toNano } from '@ton/core';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

import { Mailbox } from '../wrappers/Mailbox';
import { THookMetadata } from '../wrappers/utils/types';

function loadDeployedContracts(domain: number) {
  const filePath = path.join(__dirname, `../deployedContracts_${domain}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployed contracts file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export async function run(provider: NetworkProvider) {
  const dispatchDomain = Number(process.env.DISPATCH_DOMAIN) || 0;
  const targetDomain = Number(process.env.TARGET_DOMAIN) || 0;

  if (!dispatchDomain || !targetDomain) {
    throw new Error(
      'DISPATCH_DOMAIN or TARGET_DOMAIN environment variables are not set or invalid.',
    );
  }

  const deployedContracts = loadDeployedContracts(dispatchDomain);
  console.log(`Dispatching from domain ${dispatchDomain} to ${targetDomain}`);

  const mailbox = provider.open(
    Mailbox.createFromAddress(Address.parse(deployedContracts.mailboxAddress)),
  );

  const wallet = ethers.Wallet.createRandom();

  const destAddr = Buffer.from(
    wallet.address.slice(2).padStart(64, '0'),
    'hex',
  );
  const destAddrTon = Address.parse(deployedContracts.recipientAddress).hash;

  const hookMetadata: THookMetadata = {
    variant: 0,
    msgValue: 1000n,
    gasLimit: 50000n,
    refundAddress: Address.parse(process.env.TON_ADDRESS!),
  };

  await mailbox.sendDispatch(provider.sender(), toNano('0.15'), {
    destDomain: targetDomain,
    recipientAddr: destAddrTon,
    message: beginCell().storeUint(111, 32).endCell(),
    hookMetadata,
    requiredValue: toNano('0.1'),
  });
}
