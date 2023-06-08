import { AgentConnectionType } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { Role } from '../roles';

import { DockerConfig } from './agent';

export interface ContextAndRoles {
  context: Contexts;
  roles: Role[];
}

export type ContextAndRolesMap = Partial<Record<Contexts, Role[]>>;

export interface KeyFunderConfig {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
  contextFundingFrom: Contexts;
  contextsAndRolesToFund: ContextAndRolesMap;
  cyclesBetweenEthereumMessages?: number;
  prometheusPushGateway: string;
  connectionType: AgentConnectionType.Http | AgentConnectionType.HttpQuorum;
}
