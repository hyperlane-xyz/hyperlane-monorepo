import { EnvironmentConfig } from '@abacus-network/deploy';
import { AgentConfig } from './agent';
import { CoreConfig } from '../core';
import { GovernanceConfig } from '../governance';

export type CoreEnvironmentConfig = EnvironmentConfig & {
    agent: AgentConfig;
    core: CoreConfig;
    governance: GovernanceConfig;
}

export const ALL_ENVIRONMENTS = ['test'] as const;
type DeployEnvironmentTuple = typeof ALL_ENVIRONMENTS;
export type DeployEnvironment = DeployEnvironmentTuple[number];
