import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainName } from '@hyperlane-xyz/sdk';

import {
  getKeysForRole,
  getMultiProtocolProvider,
  getMultiProviderForRole,
} from '../../../scripts/agent-utils.js';
import { getRegistryForEnvironment } from '../../../src/config/chain.js';
import { EnvironmentConfig } from '../../../src/config/environment.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { agents } from './agent.js';
import {
  chainMetadataOverrides,
  environment as environmentName,
  supportedChainNamesInRegistry,
} from './chains.js';
import { core } from './core.js';
import { keyFunderConfig } from './funding.js';
import { igp } from './igp.js';
import { infrastructure } from './infrastructure.js';
import { owners } from './owners.js';
const getRegistry = async (
  useSecrets = true,
  chains: ChainName[] = supportedChainNamesInRegistry,
): Promise<IRegistry> =>
  getRegistryForEnvironment(
    environmentName,
    chains,
    chainMetadataOverrides,
    useSecrets,
  );

export const environment: EnvironmentConfig = {
  environment: environmentName,
  supportedChainNames: supportedChainNamesInRegistry,
  getRegistry,
  getMultiProtocolProvider: async () =>
    getMultiProtocolProvider(await getRegistry()),
  getMultiProvider: async (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
    useSecrets?: boolean,
    chains?: ChainName[],
  ) => {
    const providerChains =
      chains && chains.length > 0 ? chains : supportedChainNamesInRegistry;
    return getMultiProviderForRole(
      environmentName,
      providerChains,
      await getRegistry(useSecrets, providerChains),
      context,
      role,
      undefined,
    );
  },
  getKeys: (
    context: Contexts = Contexts.Hyperlane,
    role: Role = Role.Deployer,
  ) =>
    getKeysForRole(
      environmentName,
      supportedChainNamesInRegistry,
      context,
      role,
    ),
  agents,
  core,
  igp,
  infra: infrastructure,
  owners,
  keyFunderConfig,
};
