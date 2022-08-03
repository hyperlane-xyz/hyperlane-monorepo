import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { DockerConfig } from './agent';

export interface RelayerFunderConfig {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
  contextFundingFrom: Contexts;
  contextsToFund: Contexts[];
  rolesToFund: KEY_ROLE_ENUM[];
  prometheusPushGateway: string;
}
