import { HelloWorldApp, helloWorldFactories } from '@hyperlane-xyz/helloworld';
import {
  AgentConnectionType,
  HyperlaneCore,
  MultiProvider,
  attachContractsMap,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { EnvironmentConfig } from '../../src/config';
import { deployEnvToSdkEnv } from '../../src/config/environment';
import { HelloWorldConfig } from '../../src/config/helloworld';

export async function getApp(
  coreConfig: EnvironmentConfig,
  context: Contexts,
  keyRole: KEY_ROLE_ENUM,
  keyContext: Contexts = context,
  connectionType: AgentConnectionType = AgentConnectionType.Http,
) {
  const multiProvider: MultiProvider = await coreConfig.getMultiProvider(
    keyContext,
    keyRole,
    connectionType,
  );
  const helloworldConfig = getHelloWorldConfig(coreConfig, context);
  const contracts = attachContractsMap(
    helloworldConfig.addresses,
    helloWorldFactories,
  );
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[coreConfig.environment],
    multiProvider,
  );
  return new HelloWorldApp(core, contracts, multiProvider);
}

export function getHelloWorldConfig(
  coreConfig: EnvironmentConfig,
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
