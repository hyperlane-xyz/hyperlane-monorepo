import { HelloWorldChecker } from '@hyperlane-xyz/helloworld';

import { Contexts } from '../../config/contexts';
import { Role } from '../../src/roles';
import {
  getArgs,
  getEnvironmentConfig,
  getRouterConfig,
  withContext,
} from '../utils';

import { getHelloWorldApp } from './utils';

async function main() {
  const { environment, context } = await withContext(getArgs()).argv;
  const coreConfig = getEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  console.log('check.ts a');
  const app = await getHelloWorldApp(
    coreConfig,
    context,
    Role.Deployer,
    Contexts.Hyperlane, // Owner should always be from the hyperlane context
  );
  console.log('check.ts b');
  const configMap = await getRouterConfig(environment, multiProvider, true);
  console.log('configMap', configMap);
  const checker = new HelloWorldChecker(multiProvider, app, configMap);
  await checker.check();
  // console.log('checker.violations', checker.violations);
  checker.logViolationsTable();
  checker.expectEmpty();
}

main()
  .then(() => console.info('HelloWorld check complete'))
  .catch(console.error);
