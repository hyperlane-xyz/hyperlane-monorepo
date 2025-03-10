import { NetworkProvider, compile } from '@ton/blueprint';
import { Dictionary, toNano } from '@ton/core';
import { ethers } from 'ethers';
import * as fs from 'fs';

import { MultisigIsm } from '../wrappers/MultisigIsm';
import { buildValidatorsDict } from '../wrappers/utils/builders';

import { loadDeployedContracts } from './loadDeployedContracts';

export async function run(provider: NetworkProvider) {
  const domain = Number(process.env.ORIGIN_DOMAIN!);
  let deployedContracts = loadDeployedContracts(domain);

  console.log('domain', domain);
  console.log('version', Number(process.env.MAILBOX_VERSION!));

  const sampleWallet = new ethers.Wallet(process.env.VALIDATOR_KEY!);
  const dict = Dictionary.empty(
    Dictionary.Keys.BigUint(32),
    Dictionary.Values.Dictionary(
      Dictionary.Keys.BigUint(32),
      Dictionary.Values.BigInt(256),
    ),
  );
  dict.set(0n, buildValidatorsDict([BigInt(sampleWallet.address)]));
  const multisigIsm = provider.open(
    MultisigIsm.createFromConfig(
      {
        moduleType: 5,
        threshold: 1,
        owner: provider.sender().address!,
        validators: dict,
      },
      await compile('MultisigIsm'),
    ),
  );

  await multisigIsm.sendDeploy(provider.sender(), toNano('0.05'));

  await provider.waitForDeploy(multisigIsm.address);

  const data = {
    mailboxAddress: deployedContracts.mailboxAddress,
    interchainGasPaymasterAddress:
      deployedContracts.interchainGasPaymasterAddress,
    recipientAddress: deployedContracts.recipientAddress,
    multisigIsmAddress: multisigIsm.address.toString(),
    validatorAnnounceAddress: deployedContracts.validatorAnnounceAddress,
    merkleTreeHookAddress: deployedContracts.merkleTreeHookAddress,
  };

  fs.writeFileSync(`./deployedContracts_${domain}.json`, JSON.stringify(data));
}
