import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { KeyFunderConfig } from '../../../src/config/funding';
import { Role } from '../../../src/roles';
import { Contexts } from '../../contexts';

import { environment } from './chains';

export const keyFunderConfig: KeyFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '402a7d4-20240308-134716',
  },
  // We're currently using the same deployer key as mainnet.
  // To minimize nonce clobbering we offset the key funder cron
  // schedule by 30 minutes.
  cronSchedule: '15 * * * *', // Every hour at the 15-minute mark
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  contextFundingFrom: Contexts.Hyperlane,
  contextsAndRolesToFund: {
    [Contexts.Hyperlane]: [Role.Relayer, Role.Kathy],
    [Contexts.ReleaseCandidate]: [Role.Relayer, Role.Kathy],
  },
  connectionType: RpcConsensusType.Single,
  // desired balance config
  desiredBalancePerChain: {
    avalanche: '5',
    bsc: '5',
    celo: '3',
    ethereum: '0.5',
    gnosis: '5',
    inevm: '3',
    moonbeam: '5',
    polygon: '20',
    viction: '3',
    // Funder boosts itself upto 5x balance on L2 before dispersing funds
    arbitrum: '0.5',
    base: '0.5',
    optimism: '0.5',
    polygonzkevm: '0.5',
    scroll: '0.5',
  },
  desiredKathyBalancePerChain: {
    arbitrum: '0.1',
    avalanche: '6',
    base: '0.05',
    bsc: '0.35',
    celo: '150',
    ethereum: '0.4',
    gnosis: '100',
    inevm: '0.05',
    moonbeam: '250',
    optimism: '0.1',
    polygon: '85',
    polygonzkevm: '0.05',
    scroll: '0.05',
    viction: '0.05',
  },
};
