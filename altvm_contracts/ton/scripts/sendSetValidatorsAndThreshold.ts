import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { ethers } from 'ethers';

import { MultisigIsm } from '../wrappers/MultisigIsm';
import { buildValidatorsDict } from '../wrappers/utils/builders';

import { loadDeployedContracts } from './loadDeployedContracts';

export async function run(provider: NetworkProvider) {
  const sampleWallet = new ethers.Wallet(process.env.VALIDATOR_KEY!);
  const domain = Number(process.env.ORIGIN_DOMAIN) || 0;
  const targetDomain = Number(process.env.TARGET_DOMAIN) || 0;

  let deployedContracts = loadDeployedContracts(domain);
  const multisigIsm = provider.open(
    MultisigIsm.createFromAddress(
      Address.parse(deployedContracts.multisigIsmAddress),
    ),
  );

  console.log('msig address:', multisigIsm.address);

  await multisigIsm.sendSetValidatorsAndThreshold(
    provider.sender(),
    toNano('0.1'),
    {
      threshold: 1,
      domain: targetDomain,
      validators: buildValidatorsDict([BigInt(sampleWallet.address)]),
    },
  );
}
