import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

import * as deployedContracts from '../deployedContracts.json';
import { MultisigIsm } from '../wrappers/MultisigIsm';
import { buildValidatorsDict } from '../wrappers/utils/builders';

function loadDeployedContracts(domain: number) {
  const filePath = path.join(__dirname, `../deployedContracts_${domain}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployed contracts file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export async function run(provider: NetworkProvider) {
  const sampleWallet = new ethers.Wallet(process.env.VALIDATOR_KEY!);
  const domain = Number(process.env.SET_VALIDATORS_DOMAIN) || 0;

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
      domain,
      validators: buildValidatorsDict([BigInt(sampleWallet.address)]),
    },
  );
}
