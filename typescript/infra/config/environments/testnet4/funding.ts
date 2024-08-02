import { KeyFunderConfig } from '../../../src/config/funding.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import { environment } from './chains.js';
import { testnet4SupportedChainNames } from './supportedChainNames.js';

export const keyFunderConfig: KeyFunderConfig<
  typeof testnet4SupportedChainNames
> = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '64cdc5f-20240715-212744',
  },
  // We're currently using the same deployer key as testnet2.
  // To minimize nonce clobbering we offset the key funder cron
  // schedule by 30 minutes.
  cronSchedule: '15 * * * *', // Every hour at the 15-minute mark
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
    alfajores: '5',
    bsctestnet: '5',
    connextsepolia: '1',
    fuji: '5',
    holesky: '5',
    plumetestnet: '0.2',
    // Funder boosts itself upto 5x balance on L2 before dispersing funds
    scrollsepolia: '1',
    sepolia: '5',
    superpositiontestnet: '1',
    // no funding for solana
    eclipsetestnet: '0',
    solanatestnet: '0',
  },
  desiredKathyBalancePerChain: {
    alfajores: '1',
    bsctestnet: '1',
    connextsepolia: '0',
    fuji: '1',
    holesky: '0',
    plumetestnet: '0.05',
    scrollsepolia: '1',
    sepolia: '1',
    superpositiontestnet: '0',
    // no funding for solana
    eclipsetestnet: '0',
    solanatestnet: '0',
  },
  igpClaimThresholdPerChain: {
    alfajores: '1',
    bsctestnet: '1',
    connextsepolia: '0.1',
    fuji: '1',
    holesky: '1',
    plumetestnet: '0.1',
    scrollsepolia: '0.1',
    sepolia: '1',
    superpositiontestnet: '0.1',
    // no funding for solana
    eclipsetestnet: '0',
    solanatestnet: '0',
  },
};
