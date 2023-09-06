import { HelloWorldChecker } from '@hyperlane-xyz/helloworld';
import { HyperlaneIsmFactory } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { helloWorldConfig } from '../../config/environments/testnet3/helloworld';
import { deployEnvToSdkEnv } from '../../src/config/environment';
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
  console.log('configMap', configMap);
  const config = helloWorldConfig(environment, context, configMap);
  console.log('config', config);
  const ismFactory = HyperlaneIsmFactory.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  const checker = new HelloWorldChecker(multiProvider, app, config, ismFactory);
  await checker.check();
  console.log('checker violations', checker.violations);
  checker.expectEmpty();
}

main()
  .then(() => console.info('HelloWorld check complete'))
  .catch(console.error);
