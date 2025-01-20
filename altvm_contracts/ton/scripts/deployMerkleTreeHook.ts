import { NetworkProvider, compile } from '@ton/blueprint';
import { Dictionary, toNano } from '@ton/core';
import * as fs from 'fs';

import * as deployedContracts from '../deployedContracts.json';
import { MerkleTreeHook } from '../wrappers/MerkleTreeHook';

export async function run(provider: NetworkProvider) {
  const dict = Dictionary.empty(
    Dictionary.Keys.Uint(8),
    Dictionary.Values.BigUint(256),
  );
  for (let i = 0; i < 32; i++) {
    dict.set(i, 0n);
  }

  const merkleTreeHook = provider.open(
    MerkleTreeHook.createFromConfig(
      {
        index: 0,
        tree: dict,
      },
      await compile('MerkleTreeHook'),
    ),
  );

  await merkleTreeHook.sendDeploy(provider.sender(), toNano('0.05'));

  await provider.waitForDeploy(merkleTreeHook.address);

  const data = {
    mailboxAddress: deployedContracts.mailboxAddress,
    interchainGasPaymasterAddress:
      deployedContracts.interchainGasPaymasterAddress,
    recipientAddress: deployedContracts.recipientAddress,
    multisigIsmAddress: deployedContracts.multisigIsmAddress,
    validatorAnnounceAddress: deployedContracts.validatorAnnounceAddress,
    merkleTreeHookAddress: merkleTreeHook.address.toString(),
  };

  fs.writeFileSync('./deployedContracts.json', JSON.stringify(data));
}
