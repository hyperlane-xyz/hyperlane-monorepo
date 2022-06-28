import { HelloWorldApp, HelloWorldContracts } from '@abacus-network/helloworld';
import { helloWorldFactories } from '@abacus-network/helloworld';
import {
  AbacusCore,
  ChainMap,
  ChainName,
  MultiProvider,
  buildContracts,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';

import { CoreEnvironmentConfig, DeployEnvironment } from '../../src/config';

export async function getConfiguration<Chain extends ChainName>(
  environment: DeployEnvironment,
  multiProvider: MultiProvider<Chain>,
): Promise<
  ChainMap<Chain, { owner: string; abacusConnectionManager: string }>
> {
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

  // Currently can't be typed as per https://github.com/abacus-network/abacus-monorepo/pull/594/files#diff-40a12589668de942078f498e0ab0fda512e1eb7397189d6d286b590ae87c45d1R31
  // @ts-ignore
  const core: AbacusCore<Chain> = AbacusCore.fromEnvironment(
    environment,
    multiProvider as any,
  );

  const configMap = core.extendWithConnectionManagers(ownerMap);
  return configMap;
}

export async function getApp<Chain extends ChainName>(
  coreConfig: CoreEnvironmentConfig<Chain>,
) {
  const addresses = coreConfig.helloWorldAddresses;
  if (!addresses) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have addresses for HelloWorld`,
    );
  }
  const contracts = buildContracts(addresses, helloWorldFactories) as ChainMap<
    Chain,
    HelloWorldContracts
  >;
  const multiProvider = await coreConfig.getMultiProvider();
  const app = new HelloWorldApp(contracts, multiProvider as any);
  return app;
}
