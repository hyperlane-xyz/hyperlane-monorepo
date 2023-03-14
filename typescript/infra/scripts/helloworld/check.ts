import { HelloWorldChecker } from '@hyperlane-xyz/helloworld';

import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import {
  getContext,
  getCoreEnvironmentConfig,
  getEnvironment,
  getRouterConfig,
} from '../utils';

import { getApp } from './utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const context = await getContext();
  const multiProvider = await coreConfig.getMultiProvider();
  const app = await getApp(
    coreConfig,
    context,
    KEY_ROLE_ENUM.Deployer,
    Contexts.Hyperlane, // Owner should always be from the hyperlane context
  );
  const configMap = await getRouterConfig(environment, multiProvider);
  const checker = new HelloWorldChecker(multiProvider, app, configMap);
  await checker.check();
  checker.expectEmpty();
}

main()
  .then(() => console.info('HelloWorld check complete'))
  .catch(console.error);
