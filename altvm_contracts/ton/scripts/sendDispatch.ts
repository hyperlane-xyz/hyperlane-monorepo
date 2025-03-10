import { NetworkProvider } from '@ton/blueprint';
import { Address, beginCell, toNano } from '@ton/core';

import { Mailbox } from '../wrappers/Mailbox';
import { HookMetadata } from '../wrappers/utils/types';

import { loadDeployedContracts } from './loadDeployedContracts';

export async function run(provider: NetworkProvider) {
  const dispatchDomain = Number(process.env.ORIGIN_DOMAIN) || 0;
  const targetDomain = Number(process.env.DESTINATION_DOMAIN) || 0;

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

  const destAddrTon = Address.parse(deployedContracts.recipientAddress).hash;

  const hookMetadata = HookMetadata.fromObj({
    variant: 1,
    msgValue: 1000n,
    gasLimit: 50000n,
    refundAddress: provider.sender().address!,
  });

  await mailbox.sendDispatch(provider.sender(), toNano('0.5'), {
    destDomain: targetDomain,
    recipientAddr: destAddrTon,
    messageBody: beginCell().storeStringTail('Hello, world!').endCell(),
    hookMetadata: hookMetadata.toCell(),
  });
}
