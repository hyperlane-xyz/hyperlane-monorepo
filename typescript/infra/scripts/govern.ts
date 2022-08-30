import {
  AbacusCore,
  AbacusCoreChecker,
  CoreViolationType,
} from '@abacus-network/sdk';

import { AbacusCoreGovernor } from '../src/core/govern';

import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getMultiProviderForLedger,
} from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  // 1. Use ledger to transfer ownership of remaining contracts
  // to Gnosis safes.
  // 2. Use gnosis safe tx builder to add validators

  // 1.
  const multiProvider = await getMultiProviderForLedger(
    config.transactionConfigs,
    environment,
  );

  // 2.
  // const multiProvider = await config.getMultiProvider();

  // environments union doesn't work well with typescript
  const core = AbacusCore.fromEnvironment(environment, multiProvider as any);

  const coreChecker = new AbacusCoreChecker<any>(
    multiProvider,
    core,
    config.core,
  );
  await coreChecker.check();
  // 16 ownable contracts per chain.
  await coreChecker.expectViolations([ViolationType.Owner], [6 * 16]);

  const governor = new AbacusCoreGovernor(coreChecker);

  await governor.govern();

  // 1.
  await governor.logCalls();
  // await governor.executeCalls();

  // 2.
  // await governor.logSafeCalls();
}

check().then(console.log).catch(console.error);
