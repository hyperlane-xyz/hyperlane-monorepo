import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { FundableRole, Role } from '../roles.js';

import { DockerConfig } from './agent/agent.js';

export interface ContextAndRoles {
  context: Contexts;
  roles: Role[];
}

export type ContextAndRolesMap = Partial<Record<Contexts, FundableRole[]>>;

export interface KeyFunderConfig<SupportedChains extends readonly ChainName[]> {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
  contextFundingFrom: Contexts;
  contextsAndRolesToFund: ContextAndRolesMap;
  cyclesBetweenEthereumMessages?: number;
  prometheusPushGateway: string;
  desiredBalancePerChain: Record<SupportedChains[number], string>;
  desiredKathyBalancePerChain: Record<SupportedChains[number], string>;
  igpClaimThresholdPerChain: Record<SupportedChains[number], string>;
}
