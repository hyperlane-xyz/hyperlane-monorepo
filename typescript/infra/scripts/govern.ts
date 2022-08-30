import {
  AbacusCore,
  AbacusCoreChecker,
  ViolationType,
} from '@abacus-network/sdk';

// NB: To provide ledger type declarations.
// import '@ethersproject/hardware-wallets/thirdparty.d.ts';
import { AbacusCoreGovernor } from '../src/core/govern';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  const multiProvider = await config.getMultiProvider();

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

  await governor.logCalls();
  // await governor.executeCallsLedger();
}

check().then(console.log).catch(console.error);
