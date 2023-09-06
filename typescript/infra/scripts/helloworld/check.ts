import { HelloWorldChecker, HelloWorldConfig } from '@hyperlane-xyz/helloworld';
import { ChainMap, HyperlaneIsmFactory } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from '../../config/aggregationIsm';
import { Contexts } from '../../config/contexts';
import { DeployEnvironment } from '../../src/config';
import { deployEnvToSdkEnv } from '../../src/config/environment';
import { Role } from '../../src/roles';
import {
  getArgs,
  getEnvironmentConfig,
  getRouterConfig,
  withContext,
} from '../utils';

import { getHelloWorldApp } from './utils';

export const helloWorldConfig = (
  environment: DeployEnvironment,
  context: Contexts,
  configMap: ChainMap<HelloWorldConfig>,
): ChainMap<HelloWorldConfig> =>
  objMap(configMap, (chain, config) => ({
    ...config,
    interchainSecurityModule:
      context === Contexts.Hyperlane
        ? undefined
        : aggregationIsm(environment, chain, context),
  }));

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
  const config = helloWorldConfig(environment, context, configMap);
  console.log('config', config);
  const ismFactory = HyperlaneIsmFactory.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  const checker = new HelloWorldChecker(multiProvider, app, config, ismFactory);
  await checker.check();
  // console.log('checker.violations', checker.violations);
  checker.logViolationsTable();
  checker.expectEmpty();
}

main()
  .then(() => console.info('HelloWorld check complete'))
  .catch(console.error);
