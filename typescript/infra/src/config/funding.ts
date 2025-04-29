import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { FundableRole, Role } from '../roles.js';

import { DockerConfig } from './agent/agent.js';

export interface ContextAndRoles {
  context: Contexts;
  roles: Role[];
}

export type ContextAndRolesMap = Partial<Record<Contexts, FundableRole[]>>;

export interface CronJobConfig {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
  prometheusPushGateway: string;
}

export interface KeyFunderConfig<SupportedChains extends readonly ChainName[]>
  extends CronJobConfig {
  contextFundingFrom: Contexts;
  contextsAndRolesToFund: ContextAndRolesMap;
  cyclesBetweenEthereumMessages?: number;
  desiredBalancePerChain: Record<SupportedChains[number], string>;
  desiredKathyBalancePerChain: ChainMap<string>;
  igpClaimThresholdPerChain: ChainMap<string>;
  chainsToSkip: ChainName[];
}

export interface CheckWarpDeployConfig extends CronJobConfig {
  registryCommit?: string;
}
