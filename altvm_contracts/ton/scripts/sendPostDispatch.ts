import { NetworkProvider } from '@ton/blueprint';
import { Address, beginCell, toNano } from '@ton/core';

import { InterchainGasPaymaster } from '../wrappers/InterchainGasPaymaster';
import { Mailbox } from '../wrappers/Mailbox';
import { HookMetadata, HypMessage } from '../wrappers/utils/types';

import { loadDeployedContracts } from './loadDeployedContracts';

export async function run(provider: NetworkProvider) {
  let deployedContracts = loadDeployedContracts(
    Number(process.env.ORIGIN_DOMAIN!),
  );
  console.log('igp:', deployedContracts.interchainGasPaymasterAddress);
  const recipient = Address.parse(deployedContracts.recipientAddress).hash;
  console.log('recipient:', recipient);

  const message = HypMessage.fromAny({
    version: Mailbox.version,
    nonce: 2,
    origin: 0,
    sender: Buffer.alloc(32),
    destination: 0,
    recipient,
    body: beginCell().storeUint(123, 32).endCell(),
  }).toCell();

  const hookMetadata = HookMetadata.fromObj({
    variant: 1,
    msgValue: 1000n,
    gasLimit: 50000n,
    refundAddress: Address.parse(process.env.TON_ADDRESS!),
  });

  const igp = provider.open(
    InterchainGasPaymaster.createFromAddress(
      Address.parse(deployedContracts.interchainGasPaymasterAddress),
    ),
  );

  console.log('ton address:', process.env.TON_ADDRESS!);

  await igp.sendPostDispatch(provider.sender(), toNano('0.1'), {
    message,
    hookMetadata: hookMetadata.toCell(),
  });
}
