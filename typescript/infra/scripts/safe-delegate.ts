import { LedgerSigner } from '@ethersproject/hardware-wallets';
// Due to TS funkiness, the following needs to be imported in order for this
// code to build, but needs to be removed in order for the code to run.
import '@ethersproject/hardware-wallets/thirdparty';
import { AddSafeDelegateProps } from '@safe-global/api-kit';

import { AllChains } from '@hyperlane-xyz/sdk';

import { getSafeDelegates, getSafeService } from '../src/utils/safe.js';

import { getArgs as getRootArgs } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

function getArgs() {
  return getRootArgs()
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
  const { environment, chain, delegate, safe, action } = await getArgs();
  const config = getEnvironmentConfig(environment);

  const multiProvider = await config.getMultiProvider();

  const safeService = getSafeService(chain, multiProvider);
  const delegates = await getSafeDelegates(safeService, safe);

  console.log('Connecting to ledger, ensure plugged in and unlocked...');
  // Ledger Live derivation path, vary by changing the index i.e.
  // "m/44'/60'/{CHANGE_ME}'/0/0";
  const path = "m/44'/60'/0'/0/0";
  const signer = new LedgerSigner(undefined, 'hid', path);
  const signerAddress = await signer.getAddress();
  console.log('Connected to signer with address:', signerAddress);

  const delegateConfig: AddSafeDelegateProps = {
    safeAddress: safe,
    delegatorAddress: signerAddress,
    delegateAddress: delegate,
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
