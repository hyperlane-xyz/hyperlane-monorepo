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
    tag: 'ac07f38-20250716-204554',
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
  chainsToSkip: ['hyperliquidevmtestnet'],
  // desired balance config
  desiredBalancePerChain: {
    abstracttestnet: '0.1',
    alephzeroevmtestnet: '2',
    alfajores: '5',
    arbitrumsepolia: '0.1',
    arcadiatestnet2: '0.1',
    auroratestnet: '0.05',
    basecamptestnet: '0.05',
    basesepolia: '0.1',
    bepolia: '0.05',
    bsctestnet: '5',
    carrchaintestnet: '100',
    celestiatestnet: '0',
    chronicleyellowstone: '0.001',
    citreatestnet: '0.001',
    connextsepolia: '1',
    cotitestnet: '1',
    ecotestnet: '0.02',
    // no funding for solana
    eclipsetestnet: '0',
    flametestnet: '0.1',
    formtestnet: '0.1',
    fuji: '5',
    holesky: '5',
    hyperliquidevmtestnet: '0.1',
    infinityvmmonza: '0',
    inksepolia: '0.1',
    kyvetestnet: '0',
    megaethtestnet: '0.01',
    milkywaytestnet: '0',
    modetestnet: '0.05',
    monadtestnet: '0.1',
    neuratestnet: '0.1',
    nobletestnet: '0',
    odysseytestnet: '0.1',
    optimismsepolia: '0.1',
    paradexsepolia: '0',
    plumetestnet2: '0.1',
    polygonamoy: '0.2',
    scrollsepolia: '1',
    sepolia: '5',
    starknetsepolia: '0',
    // no funding for SVM chains
    solanatestnet: '0',
    somniatestnet: '10',
    soneiumtestnet: '0.1',
    sonicblaze: '0.1',
    // no funding for SVM chains
    sonicsvmtestnet: '0',
    subtensortestnet: '0.1',
    superpositiontestnet: '1',
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
    paradexsepolia: '0',
    polygonamoy: '0',
    scrollsepolia: '1',
    sepolia: '1',
    starknetsepolia: '0',
    // no funding for solana
    solanatestnet: '0',
    superpositiontestnet: '0',
  },
  igpClaimThresholdPerChain: {
    alfajores: '1',
    arbitrumsepolia: '0.05',
    basesepolia: '0.05',
    bsctestnet: '1',
    connextsepolia: '0.1',
    ecotestnet: '0.01',
    paradexsepolia: '0', // paradexsepolia doesn't have IGP currently
    // no funding for solana
    eclipsetestnet: '0',
    fuji: '1',
    holesky: '1',
    optimismsepolia: '0.05',
    polygonamoy: '0.1',
    scrollsepolia: '0.1',
    sepolia: '1',
    // no funding for solana
    solanatestnet: '0',
    starknetsepolia: '0', // starknetsepolia doesn't have IGP currently
    superpositiontestnet: '0.1',
  },
};
