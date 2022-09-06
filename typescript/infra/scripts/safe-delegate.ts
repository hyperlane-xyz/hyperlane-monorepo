import { LedgerSigner } from '@ethersproject/hardware-wallets';
import { SafeDelegateConfig } from '@gnosis.pm/safe-service-client';
import yargs from 'yargs';

import { AllChains } from '@abacus-network/sdk';

import { getSafeDelegates, getSafeService } from '../src/utils/safe';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

function getArgs() {
  return yargs(process.argv.slice(2))
    .describe('chain', 'chain of the validator to inspect')
    .choices('chain', AllChains)
    .demandOption('chain')
    .describe('action', 'add or remove')
    .choices('action', ['add', 'remove'])
    .demandOption('action')
    .describe('delegate', 'address of the delegate')
    .demandOption('delegate')
    .string('delegate')
    .describe('safe', 'address of the safe')
    .demandOption('safe')
    .string('safe').argv;
}

async function delegate() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const { chain, delegate, safe, action } = await getArgs();

  const multiProvider = await config.getMultiProvider();
  const connection = multiProvider.getChainConnection(chain);

  const safeService = getSafeService(chain, connection);
  const delegates = await getSafeDelegates(safeService, safe);

  // Ledger Live derivation path, vary by changing the index i.e.
  // "m/44'/60'/{CHANGE_ME}'/0/0";
  const path = "m/44'/60'/0'/0/0";
  const signer = new LedgerSigner(undefined, 'hid', path);
  console.log('Connected to signer with address:', await signer.getAddress());

  const delegateConfig: SafeDelegateConfig = {
    safe,
    delegate,
    signer,
    label: 'delegate',
  };

  const baseDescription = `${delegate} as a delegate for ${chain} safe at address ${safe}`;
  if (action === 'add') {
    console.log(`Adding ${baseDescription}`);
    if (delegates.includes(delegate))
      throw new Error(`${delegate} is already a delegate`);
    await safeService.addSafeDelegate(delegateConfig);
  } else if (action === 'remove') {
    console.log(`Removing ${baseDescription}`);
    if (!delegates.includes(delegate))
      throw new Error(`${delegate} is not a delegate`);
    await safeService.removeSafeDelegate(delegateConfig);
  } else {
    throw new Error('unsupported action');
  }
}

delegate().then(console.log).catch(console.error);
