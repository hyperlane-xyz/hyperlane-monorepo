import { HelloWorldChecker } from '@hyperlane-xyz/helloworld';

import { Contexts } from '../../config/contexts';
import { Role } from '../../src/roles';
import {
  getArgs,
  getEnvironmentConfig,
  getRouterConfig,
  withContext,
} from '../utils';

import { getApp } from './utils';

async function main() {
  const { environment, context } = await withContext(getArgs()).argv;
  const coreConfig = getEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const app = await getApp(
    coreConfig,
    context,
    Role.Deployer,
    Contexts.Hyperlane, // Owner should always be from the hyperlane context
  );
  const configMap = await getRouterConfig(environment, multiProvider, true);
  const checker = new HelloWorldChecker(multiProvider, app, configMap);
  await checker.check();
  checker.expectEmpty();
}

main()
  .then(() => console.info('HelloWorld check complete'))
  .catch(console.error);
