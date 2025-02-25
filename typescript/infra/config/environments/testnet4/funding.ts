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
    tag: '7f53c0a-20250208-195222',
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
    abstracttestnet: '0.1',
    alephzeroevmtestnet: '2',
    alfajores: '5',
    arbitrumsepolia: '0.1',
    arcadiatestnet2: '0.1',
    basesepolia: '0.1',
    berabartio: '0.1',
    bsctestnet: '5',
    camptestnet: '0.1',
    chronicleyellowstone: '0.001',
    citreatestnet: '0.001',
    connextsepolia: '1',
    ecotestnet: '0.02',
    // no funding for solana
    eclipsetestnet: '0',
    flametestnet: '0.1',
    formtestnet: '0.1',
    fuji: '5',
    holesky: '5',
    hyperliquidevmtestnet: '0.1',
    inksepolia: '0.1',
    monadtestnet: '0.1',
    odysseytestnet: '0.1',
    optimismsepolia: '0.1',
    // Disabling plumetestnet on Sept 16, 2024: chain is paused for "airplane mode"
    // plumetestnet: '0.2',
    polygonamoy: '0.2',
    scrollsepolia: '1',
    sepolia: '5',
    // no funding for SVM chains
    solanatestnet: '0',
    soneiumtestnet: '0.1',
    sonicblaze: '0.1',
    // no funding for SVM chains
    sonicsvmtestnet: '0',
    suavetoliman: '0.1',
    subtensortestnet: '0.1',
    superpositiontestnet: '1',
    treasuretopaz: '5',
    unichaintestnet: '0.1',
    weavevmtestnet: '0.1',
  },
  desiredKathyBalancePerChain: {
    alfajores: '1',
    arbitrumsepolia: '0',
    basesepolia: '0',
    bsctestnet: '1',
    connextsepolia: '0',
    ecotestnet: '0',
    // no funding for solana
    eclipsetestnet: '0',
    fuji: '1',
    holesky: '0',
    optimismsepolia: '0',
    // Disabling plumetestnet on Sept 16, 2024: chain is paused for "airplane mode"
    // plumetestnet: '0.05',
    polygonamoy: '0',
    scrollsepolia: '1',
    sepolia: '1',
    // no funding for solana
    solanatestnet: '0',
    superpositiontestnet: '0',
  },
  igpClaimThresholdPerChain: {
    alfajores: '1',
    arbitrumsepolia: '0.05',
    // never claim on berachain berabartio testnet
    berabartio: '1000.0',
    basesepolia: '0.05',
    bsctestnet: '1',
    connextsepolia: '0.1',
    ecotestnet: '0.01',
    // no funding for solana
    eclipsetestnet: '0',
    fuji: '1',
    holesky: '1',
    optimismsepolia: '0.05',
    // Disabling plumetestnet on Sept 16, 2024: chain is paused for "airplane mode"
    // plumetestnet: '0.1',
    polygonamoy: '0.1',
    scrollsepolia: '0.1',
    sepolia: '1',
    // no funding for solana
    solanatestnet: '0',
    superpositiontestnet: '0.1',
  },
};
