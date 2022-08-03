import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { DockerConfig } from './agent';

export interface KeyFunderConfig {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
  contextFundingFrom: Contexts;
  contextsToFund: Contexts[];
  rolesToFund: KEY_ROLE_ENUM[];
  prometheusPushGateway: string;
}
