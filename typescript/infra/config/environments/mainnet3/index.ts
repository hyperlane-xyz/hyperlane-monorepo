import { ChainName } from '@hyperlane-xyz/sdk';

import {
  getKeysForRole,
  getMultiProtocolProvider,
  getMultiProviderForRole,
} from '../../../scripts/agent-utils.js';
import { EnvironmentConfig } from '../../../src/config/environment.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { agents } from './agent.js';
import {
  environment as environmentName,
  getRegistry,
  supportedChainNamesInRegistry,
} from './chains.js';
import { core } from './core.js';
import { keyFunderConfig } from './funding.js';
import { igp } from './igp.js';
import { infrastructure } from './infrastructure.js';
import { chainOwners } from './owners.js';
import { checkWarpDeployConfig } from './warp/checkWarpDeploy.js';

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
  owners: chainOwners,
  infra: infrastructure,
  keyFunderConfig,
  checkWarpDeployConfig,
};
