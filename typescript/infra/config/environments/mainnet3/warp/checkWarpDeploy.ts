import { CheckWarpDeployConfig } from '../../../../src/config/funding.js';
import { DockerImageRepos, mainnetDockerTags } from '../../../docker.js';
import { environment } from '../chains.js';

export const checkWarpDeployConfig: CheckWarpDeployConfig = {
  docker: {
    repo: DockerImageRepos.MONOREPO,
    tag: mainnetDockerTags.checkWarpDeploy!,
  },
  namespace: environment,
  cronSchedule: '0 15 * * *', // set to 3pm utc every day
  prometheusPushGateway:
    'http://prometheus-prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  registryCommit: 'main', // This will always use the latest version from the main branch
};
