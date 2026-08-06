import { ValidatorMonitorConfig } from '../../../src/config/funding.js';
import { DockerImageRepos, mainnetDockerTags } from '../../docker.js';

import { environment } from './chains.js';

export const validatorMonitorConfig: ValidatorMonitorConfig = {
  docker: {
    repo: DockerImageRepos.MONOREPO,
    tag: mainnetDockerTags.validatorMonitor,
  },
  namespace: environment,
  cronSchedule: '*/30 * * * *', // every 30 minutes
  prometheusPushGateway:
    'http://prometheus-prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  registryCommit: 'main', // always use the latest version from the main branch
};
