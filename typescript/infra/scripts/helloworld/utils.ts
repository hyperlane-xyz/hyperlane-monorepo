import {
  HelloWorldApp,
  HelloWorldContracts,
  helloWorldFactories,
} from '@abacus-network/helloworld';
import {
  AbacusCore,
  ChainMap,
  ChainName,
  MultiProvider,
  RouterConfig,
  buildContracts,
} from '@abacus-network/sdk';
import { partialObjMap } from '@abacus-network/sdk/dist/utils';

import { CoreEnvironmentConfig, DeployEnvironment } from '../../src/config';
import { HelloWorldConfig } from '../../src/config/helloworld';

export async function getConfiguration<Chain extends ChainName>(
  environment: DeployEnvironment,
  multiProvider: MultiProvider,
): Promise<ChainMap<Chain, RouterConfig>> {
  // TODO can't assume signer
  const ownerMap = await promiseObjAll(
    partialObjMap(multiProvider.chainMap, async (chain, chainConnection) => {
      const signer = chainConnection.signer;
      if (!signer) throw new Error(`No signer for chain ${chain}`);
      const owner = await signer.getAddress();
      return { owner };
    }),
  );

  // Currently can't be typed as per https://github.com/abacus-network/abacus-monorepo/pull/594/files#diff-40a12589668de942078f498e0ab0fda512e1eb7397189d6d286b590ae87c45d1R31
  // @ts-ignore
  const core: AbacusCore<Chain> = AbacusCore.fromEnvironment(
    environment,
    multiProvider as any,
  );

  return core.extendWithConnectionClientConfig(ownerMap);
}

export async function getApp<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
) {
  const helloworldConfig = getHelloWorldConfig(coreConfig);
  const contracts = buildContracts(
    helloworldConfig.addresses,
    helloWorldFactories,
  ) as ChainMap<Chain, HelloWorldContracts>;
  const multiProvider = await coreConfig.getMultiProvider();
  const app = new HelloWorldApp(contracts, multiProvider as any);
  return app;
}

export function getHelloWorldConfig<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
): HelloWorldConfig<Chain> {
  const helloWorldConfig = coreConfig.helloWorld;
  if (!helloWorldConfig) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a HelloWorld config`,
    );
  }
  return helloWorldConfig;
}
