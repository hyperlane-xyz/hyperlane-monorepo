import { KeyFunderConfig } from '../../../src/config/funding.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { environment } from './chains.js';

export const keyFunderConfig: KeyFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: 'b134b04-20240605-133031',
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
  // desired balance config
  desiredBalancePerChain: {
    arbitrum: '0.5',
    ancient8: '0.5',
    avalanche: '5',
    base: '0.5',
    blast: '0.2',
    bob: '0.2',
    bsc: '5',
    celo: '3',
    ethereum: '0.5',
    fraxtal: '0.2',
    gnosis: '5',
    inevm: '3',
    linea: '0.2',
    mantapacific: '0.2',
    mantle: '20',
    mode: '0.2',
    moonbeam: '5',
    optimism: '0.5',
    polygon: '20',
    polygonzkevm: '0.5',
    redstone: '0.2',
    scroll: '0.5',
    sei: '10',
    taiko: '0.2',
    viction: '3',
    zetachain: '20',
  },
  desiredKathyBalancePerChain: {
    arbitrum: '0.1',
    ancient8: '0',
    avalanche: '6',
    base: '0.05',
    blast: '0',
    bob: '0',
    bsc: '0.35',
    celo: '150',
    ethereum: '0.4',
    fraxtal: '0',
    gnosis: '100',
    inevm: '0.05',
    linea: '0',
    mantapacific: '0',
    mantle: '0',
    mode: '0',
    moonbeam: '250',
    optimism: '0.1',
    polygon: '85',
    polygonzkevm: '0.05',
    redstone: '0',
    scroll: '0.05',
    sei: '0',
    taiko: '0',
    viction: '0.05',
    zetachain: '0',
  },
};
