import { KeyFunderConfig } from '../../../src/config/funding.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';

import desiredRelayerBalances from './balances/desiredRelayerBalances.json' with { type: 'json' };
import { environment } from './chains.js';
import { mainnet3SupportedChainNames } from './supportedChainNames.js';

type DesiredRelayerBalanceChains = keyof typeof desiredRelayerBalances;
const desiredRelayerBalancePerChain = Object.fromEntries(
  Object.entries(desiredRelayerBalances).map(([chain, balance]) => [
    chain,
    balance.toString(),
  ]),
) as Record<DesiredRelayerBalanceChains, string>;

export const keyFunderConfig: KeyFunderConfig<
  typeof mainnet3SupportedChainNames
> = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '6e952db-20250604-152023',
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
  chainsToSkip: ['real', 'trumpchain'],
  // desired balance config, must be set for each chain
  desiredBalancePerChain: desiredRelayerBalancePerChain,
  // if not set, keyfunder defaults to 0
  desiredKathyBalancePerChain: {
    ancient8: '0',
    arbitrum: '0.1',
    avalanche: '6',
    base: '0.05',
    blast: '0',
    bob: '0',
    bsc: '0.35',
    celo: '150',
    cheesechain: '0',
    cyber: '0',
    degenchain: '0',
    endurance: '0',
    ethereum: '0.4',
    fraxtal: '0',
    fusemainnet: '0',
    gnosis: '100',
    inevm: '0.05',
    kroma: '0',
    linea: '0',
    lisk: '0',
    lukso: '0',
    mantapacific: '0',
    mantle: '0',
    merlin: '0',
    metis: '0',
    mint: '0',
    mode: '0',
    moonbeam: '250',
    optimism: '0.1',
    polygon: '85',
    polygonzkevm: '0.05',
    proofofplay: '0',
    real: '0',
    redstone: '0',
    sanko: '0',
    scroll: '0.05',
    sei: '0',
    taiko: '0',
    tangle: '0',
    viction: '0.05',
    worldchain: '0',
    xai: '0',
    xlayer: '0',
    zetachain: '0',
    zircuit: '0',
    zoramainnet: '0',
    // ignore non-evm chains
    injective: '0',
    neutron: '0',
    osmosis: '0',
    eclipsemainnet: '0',
    solanamainnet: '0',
    soon: '0',
    sonicsvm: '0',
  },
  // if not set, keyfunder defaults to using desired balance * 0.2 as the threshold
  igpClaimThresholdPerChain: {
    ancient8: '0.1',
    arbitrum: '0.1',
    avalanche: '2',
    base: '0.1',
    blast: '0.1',
    bob: '0.1',
    bsc: '0.3',
    celo: '5',
    cheesechain: '25',
    cyber: '0.025',
    degenchain: '50',
    endurance: '10',
    ethereum: '0.2',
    fraxtal: '0.1',
    fusemainnet: '10',
    gnosis: '5',
    inevm: '3',
    kroma: '0.025',
    linea: '0.1',
    lisk: '0.025',
    lukso: '10',
    mantapacific: '0.1',
    mantle: '10',
    merlin: '0.001',
    metis: '1',
    mint: '0.025',
    mode: '0.1',
    moonbeam: '5',
    optimism: '0.1',
    polygon: '20',
    polygonzkevm: '0.1',
    proofofplay: '0.025',
    real: '0.05',
    redstone: '0.1',
    sanko: '1',
    scroll: '0.1',
    sei: '5',
    taiko: '0.1',
    tangle: '1',
    viction: '2',
    worldchain: '0.1',
    xai: '10',
    xlayer: '0.25',
    zetachain: '20',
    zircuit: '0.01',
    zoramainnet: '0.1',
    // ignore non-evm chains
    injective: '0',
    neutron: '0',
    osmosis: '0',
    eclipsemainnet: '0',
    solanamainnet: '0',
    soon: '0',
    sonicsvm: '0',
  },
};
