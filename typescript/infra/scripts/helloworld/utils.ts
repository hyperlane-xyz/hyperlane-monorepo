import {
  HelloWorldApp,
  HelloWorldContracts,
  helloWorldFactories,
} from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  HyperlaneCore,
  MultiProvider,
  RouterConfig,
  buildContracts,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { CoreEnvironmentConfig, DeployEnvironment } from '../../src/config';
import { ConnectionType } from '../../src/config/agent';
import { deployEnvToSdkEnv } from '../../src/config/environment';
import { HelloWorldConfig } from '../../src/config/helloworld';

export async function getConfiguration(
  environment: DeployEnvironment,
  multiProvider: MultiProvider,
): Promise<ChainMap<RouterConfig>> {
  const ownerMap: ChainMap<{ owner: string }> = {};
  for (const chain of multiProvider.getKnownChainNames()) {
    ownerMap[chain] = {
      owner: await multiProvider.getSignerAddress(chain),
    };
  }

  const core: HyperlaneCore = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  return core.extendWithConnectionClientConfig(ownerMap);
}

export async function getApp(
  coreConfig: CoreEnvironmentConfig,
  context: Contexts,
  keyRole: KEY_ROLE_ENUM,
  keyContext: Contexts = context,
  connectionType: ConnectionType = ConnectionType.Http,
) {
  const helloworldConfig = getHelloWorldConfig(coreConfig, context);
  const contracts = buildContracts(
    helloworldConfig.addresses,
    helloWorldFactories,
  ) as ChainMap<HelloWorldContracts>;
  const multiProvider: MultiProvider = await coreConfig.getMultiProvider(
    keyContext,
    keyRole,
    connectionType,
  );
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[coreConfig.environment],
    multiProvider,
  ) as HyperlaneCore;
  return new HelloWorldApp(core, contracts, multiProvider);
}

export function getHelloWorldConfig(
  coreConfig: CoreEnvironmentConfig,
  context: Contexts,
): HelloWorldConfig {
  const helloWorldConfigs = coreConfig.helloWorld;
  if (!helloWorldConfigs) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a HelloWorld config`,
    );
  }
  const config = helloWorldConfigs[context];
  if (!config) {
    throw new Error(`Context ${context} does not have a HelloWorld config`);
  }
  return config;
}
