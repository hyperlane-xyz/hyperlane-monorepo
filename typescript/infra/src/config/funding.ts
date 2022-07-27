import { Contexts } from '../../config/contexts';

import { DockerConfig } from './agent';

export interface RelayerFunderConfig {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
  contextFundingFrom: Contexts;
  contextsToFund: Contexts[];
  prometheusPushGateway: string;
}
