import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { KeyFunderConfig } from '../../../src/config/funding.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { environment } from './chains.js';

export const keyFunderConfig: KeyFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '5d1391c-20240418-100607',
  },
  // We're currently using the same deployer/key funder key as mainnet2.
  // To minimize nonce clobbering we offset the key funder cron
  // to run 30 mins after the mainnet2 cron.
  cronSchedule: '45 * * * *', // Every hour at the 45-minute mark
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  contextFundingFrom: Contexts.Hyperlane,
  contextsAndRolesToFund: {
    [Contexts.Hyperlane]: [Role.Relayer, Role.Kathy],
    [Contexts.ReleaseCandidate]: [Role.Relayer, Role.Kathy],
  },
  connectionType: RpcConsensusType.Fallback,
  // desired balance config
  desiredBalancePerChain: {
    avalanche: '5',
    bsc: '5',
    blast: '0.2',
    celo: '3',
    ethereum: '0.5',
    gnosis: '5',
    inevm: '3',
    mode: '0.2',
    moonbeam: '5',
    polygon: '20',
    viction: '3',
    // Funder boosts itself upto 5x balance on L2 before dispersing funds
    arbitrum: '0.5',
    base: '0.5',
    optimism: '0.5',
    polygonzkevm: '0.5',
    scroll: '0.5',
    ancient8: '0.5',
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
