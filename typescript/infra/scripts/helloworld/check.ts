import { HelloWorldChecker } from '@abacus-network/helloworld';

import { getCoreEnvironmentConfig, getEnvironment } from '../utils';

import { getApp, getConfiguration } from './utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider();
  const app = await getApp(coreConfig);
  const configMap = await getConfiguration(environment, multiProvider);
  const checker = new HelloWorldChecker(multiProvider, app, configMap);
  await checker.check();
  checker.expectEmpty();
}

main()
  .then(() => console.info('HelloWorld check complete'))
  .catch(console.error);
