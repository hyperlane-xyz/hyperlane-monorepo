import { HelloMultiProtocolApp } from '@hyperlane-xyz/helloworld';
import {
  AgentConnectionType,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { EnvironmentConfig } from '../../src/config';
import { HelloWorldConfig } from '../../src/config/helloworld';
import { Role } from '../../src/roles';

export async function getHelloWorldApp(
  coreConfig: EnvironmentConfig,
  context: Contexts,
  keyRole: Role,
  keyContext: Contexts = context,
  connectionType: AgentConnectionType = AgentConnectionType.Http,
) {
  const multiProvider: MultiProvider = await coreConfig.getMultiProvider(
    keyContext,
    keyRole,
    connectionType,
  );

  const helloworldConfig = getHelloWorldConfig(coreConfig, context);

  const multiProtocolProvider = MultiProtocolProvider.fromMultiProvider(
    multiProvider,
  ).extendChainMetadata(helloworldConfig.addresses);

  const app = new HelloMultiProtocolApp(multiProtocolProvider);

  return { app, multiProvider, multiProtocolProvider };
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
