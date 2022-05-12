import { AbacusCore, ControllerApp } from '@abacus-network/sdk';

import { ControllerChecker } from '../src/controller';
import { AbacusCoreChecker } from '../src/core';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  if (environment !== 'test') {
    throw new Error(
      `Do not have controller addresses for ${environment} in SDK`,
    );
  }

  const core = AbacusCore.fromEnvironment(environment, multiProvider);
  const controller = ControllerApp.fromEnvironment(environment, multiProvider);

  const controllerChecker = new ControllerChecker(
    multiProvider,
    controller,
    config.controller,
  );
  await controllerChecker.check();
  controllerChecker.expectEmpty();

  const owners = controller.routerAddresses();
  const coreChecker = new AbacusCoreChecker(multiProvider, core, {
    ...config.core,
    owners,
  } as any);
  await coreChecker.check();
  coreChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
