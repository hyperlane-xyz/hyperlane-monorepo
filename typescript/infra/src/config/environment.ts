import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainName,
  CoreConfig,
  IgpConfig,
  MultiProtocolProvider,
  MultiProvider,
  OwnableConfig,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { CloudAgentKey } from '../agents/keys.js';
import { Role } from '../roles.js';

import { RootAgentConfig } from './agent/agent.js';
import type { DeployEnvironment } from './deploy-environment.js';
import { CheckWarpDeployConfig, KeyFunderConfig } from './funding.js';
import { InfrastructureConfig } from './infrastructure.js';

export type EnvironmentConfig = {
  environment: DeployEnvironment;
  supportedChainNames: ChainName[];
  // Get the registry with or without environment-specific secrets.
  // Optionally filter to specific chains for performance optimization.
  getRegistry: (
    useSecrets?: boolean,
    chains?: ChainName[],
  ) => Promise<IRegistry>;
  // Each AgentConfig, keyed by the context
  agents: Partial<Record<Contexts, RootAgentConfig>>;
  core: ChainMap<CoreConfig>;
  igp: ChainMap<IgpConfig>;
  owners: ChainMap<OwnableConfig>;
  infra: InfrastructureConfig;
  getMultiProtocolProvider: () => Promise<MultiProtocolProvider>;
  getMultiProvider: (
    context?: Contexts,
    role?: Role,
    useSecrets?: boolean,
    chains?: ChainName[],
  ) => Promise<MultiProvider>;
  getKeys: (
    context?: Contexts,
    role?: Role,
  ) => Promise<ChainMap<CloudAgentKey>>;
  keyFunderConfig?: KeyFunderConfig<string[]>;
  checkWarpDeployConfig?: CheckWarpDeployConfig;
};

export function getOwnerConfigForAddress(owner: string): OwnableConfig {
  return {
    owner,
    // To ensure that any other overrides aren't applied
    ownerOverrides: {
      proxyAdmin: owner,
    },
  };
}
