import { KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { ConnectionType } from '../../../src/config/agent';
import { KeyFunderConfig } from '../../../src/config/funding';
import { Contexts } from '../../contexts';

import { environment } from './chains';

export const keyFunderConfig: KeyFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: 'sha-0d76398',
  },
  cronSchedule: '45 * * * *', // Every hour at the 45 minute mark
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  contextFundingFrom: Contexts.Abacus,
  contextsAndRolesToFund: {
    [Contexts.Abacus]: [KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy],
    [Contexts.ReleaseCandidate]: [KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy],
  },
  connectionType: ConnectionType.Http,
};
