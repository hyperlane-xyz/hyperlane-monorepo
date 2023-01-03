import {
  HelloWorldApp,
  HelloWorldContracts,
  helloWorldFactories,
} from '@hyperlane-xyz/helloworld';
import {
  ChainMap,
  ChainName,
  HyperlaneCore,
  MultiProvider,
  RouterConfig,
  buildContracts,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { CoreEnvironmentConfig, DeployEnvironment } from '../../src/config';
import { ConnectionType } from '../../src/config/agent';
import { HelloWorldConfig } from '../../src/config/helloworld';
import { deployEnvToSdkEnv } from '../utils';

export async function getConfiguration<Chain extends ChainName>(
  environment: DeployEnvironment,
  multiProvider: MultiProvider<Chain>,
): Promise<ChainMap<Chain, RouterConfig>> {
  const signerMap = await promiseObjAll(
    multiProvider.map(async (_, dc) => dc.signer!),
  );
  const ownerMap = await promiseObjAll(
    objMap(signerMap, async (_, signer) => {
      return {
        owner: await signer.getAddress(),
      };
    }),
  );

  // Currently can't be typed as per https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/594/files#diff-40a12589668de942078f498e0ab0fda512e1eb7397189d6d286b590ae87c45d1R31
  // @ts-ignore
  const core: HyperlaneCore<Chain> = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider as any,
  );

  return core.extendWithConnectionClientConfig(ownerMap);
}

export async function getApp<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
  context: Contexts,
  keyRole: KEY_ROLE_ENUM,
  keyContext: Contexts = context,
  connectionType: ConnectionType = ConnectionType.Http,
) {
  const helloworldConfig = getHelloWorldConfig(coreConfig, context);
  const contracts = buildContracts(
    helloworldConfig.addresses,
    helloWorldFactories,
  ) as ChainMap<Chain, HelloWorldContracts>;
  const multiProvider: MultiProvider<any> = await coreConfig.getMultiProvider(
    keyContext,
    keyRole,
    connectionType,
  );
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[coreConfig.environment],
    multiProvider as any,
  ) as HyperlaneCore<any>;
  return new HelloWorldApp(core, contracts, multiProvider);
}

export function getHelloWorldConfig<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
  context: Contexts,
): HelloWorldConfig<Chain> {
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
