import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { ConnectionType, DockerConfig } from './agent';

export interface ContextAndRoles {
  context: Contexts;
  roles: KEY_ROLE_ENUM[];
}

export type ContextAndRolesMap = Partial<Record<Contexts, KEY_ROLE_ENUM[]>>;

export interface KeyFunderConfig {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
  contextFundingFrom: Contexts;
  contextsAndRolesToFund: ContextAndRolesMap;
  cyclesBetweenEthereumMessages?: number;
  prometheusPushGateway: string;
  connectionType: ConnectionType.Http | ConnectionType.HttpQuorum;
}
