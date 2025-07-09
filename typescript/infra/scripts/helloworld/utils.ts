import {
  HelloMultiProtocolApp,
  HelloWorldApp,
  helloWorldFactories,
} from '@hyperlane-xyz/helloworld';
import {
  HyperlaneIgp,
  MultiProtocolCore,
  MultiProtocolProvider,
  MultiProvider,
  attachContractsMap,
  attachContractsMapAndGetForeignDeployments,
  filterChainMapToProtocol,
  igpFactories,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getEnvAddresses } from '../../config/registry.js';
import { EnvironmentConfig } from '../../src/config/environment.js';
import { HelloWorldConfig } from '../../src/config/helloworld/types.js';
import { Role } from '../../src/roles.js';
import { getHyperlaneCore } from '../core-utils.js';

export async function getHelloWorldApp(
  coreConfig: EnvironmentConfig,
  context: Contexts,
  keyRole: Role,
  keyContext: Contexts = context,
) {
  const multiProvider: MultiProvider = await coreConfig.getMultiProvider(
    keyContext,
    keyRole,
  );
  const helloworldConfig = getHelloWorldConfig(coreConfig, context);

  const { contractsMap, foreignDeployments } =
    attachContractsMapAndGetForeignDeployments(
      helloworldConfig.addresses,
      helloWorldFactories,
      multiProvider,
    );

  const { core } = await getHyperlaneCore(
    coreConfig.environment,
    multiProvider,
  );
  return new HelloWorldApp(
    core,
    contractsMap,
    multiProvider,
    foreignDeployments,
  );
}

export async function getHelloWorldMultiProtocolApp(
  coreConfig: EnvironmentConfig,
  context: Contexts,
  keyRole: Role,
  keyContext: Contexts = context,
) {
  const multiProvider: MultiProvider = await coreConfig.getMultiProvider(
    keyContext,
    keyRole,
  );

  const envAddresses = getEnvAddresses(coreConfig.environment);
  const keys = await coreConfig.getKeys(keyContext, keyRole);

  // Fetch all the keys, which is required to get the address for
  // certain cloud keys
  await Promise.all(Object.values(keys).map((key) => key.fetch()));

  const helloworldConfig = getHelloWorldConfig(coreConfig, context);

  const multiProtocolProvider =
    MultiProtocolProvider.fromMultiProvider(multiProvider);
  // Hacking around infra code limitations, we may need to add solana manually
  // because the it's not in typescript/infra/config/environments/testnet4/chains.ts
  // Adding it there breaks many things
  // if (
  //   coreConfig.environment === 'testnet3' &&
  //   !multiProtocolProvider.getKnownChainNames().includes('solanadevnet')
  // ) {
  //   multiProvider.addChain(chainMetadata.solanadevnet);
  //   multiProtocolProvider.addChain(chainMetadata.solanadevnet);
  //   keys['solanadevnet'] = getKeyForRole(
  //     coreConfig.environment,
  //     context,
  //     'solanadevnet',
  //     keyRole,
  //   );
  //   await keys['solanadevnet'].fetch();
  // } else

  // if (
  //   coreConfig.environment === 'mainnet3' &&
  //   !multiProtocolProvider.getKnownChainNames().includes('solanamainnet')
  // ) {
  //   multiProvider.addChain(chainMetadata.solana);
  //   multiProtocolProvider.addChain(chainMetadata.solana);
  //   keys['solanamainnet'] = getKeyForRole(
  //     coreConfig.environment,
  //     context,
  //     'solanamainnet',
  //     keyRole,
  //   );
  //   await keys['solanamainnet'].fetch();
  // }

  const core = MultiProtocolCore.fromAddressesMap(
    envAddresses as any,
    multiProtocolProvider,
  );

  const routersAndMailboxes = objMap(
    helloworldConfig.addresses,
    (chain, addresses) => ({
      router: addresses.router,
      // @ts-ignore allow loosely typed chain name to index env addresses
      mailbox: envAddresses[chain].mailbox,
    }),
  );
  const app = new HelloMultiProtocolApp(
    multiProtocolProvider.intersect(Object.keys(routersAndMailboxes)).result,
    routersAndMailboxes,
  );

  // TODO we need a MultiProtocolIgp
  // Using a standard IGP for just evm chains for now
  // Unfortunately this requires hacking surgically around certain addresses
  const filteredAddresses = filterChainMapToProtocol(
    envAddresses,
    ProtocolType.Ethereum,
    multiProtocolProvider,
  );
  const contractsMap = attachContractsMap(filteredAddresses, igpFactories);
  const igp = new HyperlaneIgp(contractsMap, multiProvider);

  return { app, core, igp, multiProvider, multiProtocolProvider, keys };
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

// for create-key, you don't want to fetch the multisig[chain].validators.threshold for yet to be created multisigs
export function getJustHelloWorldConfig(
  helloWorldConfigs: Partial<Record<Contexts, HelloWorldConfig>> | undefined,
  context: Contexts,
): HelloWorldConfig {
  if (!helloWorldConfigs) {
    throw new Error(`Environment does not have a HelloWorld config`);
  }
  const config = helloWorldConfigs[context];
  if (!config) {
    throw new Error(`Context ${context} does not have a HelloWorld config`);
  }
  return config;
}
