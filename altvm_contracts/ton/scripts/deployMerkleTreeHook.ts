import { NetworkProvider, compile } from '@ton/blueprint';
import { Address, Dictionary, toNano } from '@ton/core';
import * as fs from 'fs';

import { MerkleTreeHook } from '../wrappers/MerkleTreeHook';

import { loadDeployedContracts } from './loadDeployedContracts';

export async function run(provider: NetworkProvider) {
  const domain = Number(process.env.ORIGIN_DOMAIN!);
  let deployedContracts = loadDeployedContracts(domain);
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
        mailboxAddr: Address.parse(deployedContracts.mailboxAddress),
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

  fs.writeFileSync(`./deployedContracts_${domain}.json`, JSON.stringify(data));
}
