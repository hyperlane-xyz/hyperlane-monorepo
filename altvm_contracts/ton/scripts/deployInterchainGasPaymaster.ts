import { NetworkProvider, compile } from '@ton/blueprint';
import { Address, Dictionary, toNano } from '@ton/core';
import * as fs from 'fs';

import * as deployedContracts from '../deployedContracts.json';
import { makeRandomBigint } from '../tests/utils/generators';
import {
  InterchainGasPaymaster,
  InterchainGasPaymasterConfig,
} from '../wrappers/InterchainGasPaymaster';
import { buildHookMetadataCell } from '../wrappers/utils/builders';
import { THookMetadata } from '../wrappers/utils/types';

export async function run(provider: NetworkProvider) {
  console.log('domain', Number(process.env.DOMAIN!));
  console.log('version', Number(process.env.MAILBOX_VERSION!));
  const intialGasConfig = {
    gasOracle: 0n,
    gasOverhead: 0n,
    exchangeRate: 1n,
    gasPrice: 1000000000n,
  };

  console.log('ton address:', process.env.TON_ADDRESS!);

  const dictDestGasConfig = Dictionary.empty(
    InterchainGasPaymaster.GasConfigKey,
    InterchainGasPaymaster.GasConfigValue,
  );
  dictDestGasConfig.set(0, intialGasConfig);

  const hookMetadata: THookMetadata = {
    variant: Number(process.env.MAILBOX_VERSION),
    msgValue: 1000n,
    gasLimit: 50000n,
    refundAddress: Address.parse(process.env.TON_ADDRESS!),
  };

  const config: InterchainGasPaymasterConfig = {
    owner: Address.parse(process.env.TON_ADDRESS!),
    beneficiary: Address.parse(process.env.TON_ADDRESS!),
    hookType: 0,
    destGasConfig: dictDestGasConfig,
    hookMetadata: buildHookMetadataCell(hookMetadata),
  };
  const interchainGasPaymaster = provider.open(
    InterchainGasPaymaster.createFromConfig(
      config,
      await compile('InterchainGasPaymaster'),
    ),
  );

  await interchainGasPaymaster.sendDeploy(provider.sender(), toNano('0.05'));

  await provider.waitForDeploy(interchainGasPaymaster.address);

  const data = {
    mailboxAddress: deployedContracts.mailboxAddress,
    interchainGasPaymasterAddress: interchainGasPaymaster.address.toString(),
    recipientAddress: deployedContracts.recipientAddress,
    multisigIsmAddress: deployedContracts.multisigIsmAddress,
    validatorAnnounceAddress: deployedContracts.validatorAnnounceAddress,
    merkleTreeHookAddress: deployedContracts.merkleTreeHookAddress,
  };

  fs.writeFileSync('./deployedContracts.json', JSON.stringify(data));
}
