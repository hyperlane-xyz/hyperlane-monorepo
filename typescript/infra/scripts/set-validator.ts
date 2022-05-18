import { AbacusCore, ControllerApp } from '@abacus-network/sdk';

import { AbacusCoreControllerChecker, CoreViolationType } from '../src/core';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider);
  if (environment !== 'test') {
    throw new Error(`No governanace addresses for ${environment} in SDK`);
  }
  const controllerApp = ControllerApp.fromEnvironment(
    environment,
    multiProvider,
  );

  const checker = new AbacusCoreControllerChecker(
    multiProvider,
    core,
    controllerApp,
    config.core,
  );
  await checker.check();
  // Sanity check: for each chain, expect one validator violation.
  checker.expectViolations(
    [CoreViolationType.Validator],
    [core.chains().length],
  );
  // Sanity check: for each chain, expect one call to set the validator.
  checker.expectCalls(core.chains(), new Array(core.chains().length).fill(1));

  // Change to `batch.execute` in order to run.
  const controllerActor = await controllerApp.controller();
  const provider = multiProvider.getChainConnection(controllerActor.chain)
    .provider!;
  const receipts = await checker.controllerApp.estimateGas(provider);
  console.log(receipts);
}
main().then(console.log).catch(console.error);
