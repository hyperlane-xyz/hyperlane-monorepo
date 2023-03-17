import { AgentConnectionType } from '@hyperlane-xyz/sdk';

import { KEY_ROLE_ENUM } from '../../../src/agents/roles';
import { KeyFunderConfig } from '../../../src/config/funding';
import { Contexts } from '../../contexts';

import { environment } from './chains';

export const keyFunderConfig: KeyFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '6e0c44a-20230316-115929',
  },
  // We're currently using the same deployer key as testnet2.
  // To minimize nonce clobbering we offset the key funder cron
  // schedule by 30 minutes.
  cronSchedule: '15 * * * *', // Every hour at the 15-minute mark
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  contextFundingFrom: Contexts.Hyperlane,
  contextsAndRolesToFund: {
    [Contexts.Hyperlane]: [KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy],
    [Contexts.ReleaseCandidate]: [KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy],
  },
  connectionType: AgentConnectionType.Http,
};
