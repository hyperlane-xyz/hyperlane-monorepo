import { objMap } from '@hyperlane-xyz/utils';

import { KeyFunderConfig } from '../../../src/config/funding.js';
import { Role } from '../../../src/roles.js';
import { Contexts } from '../../contexts.js';
import { DockerImageRepos, mainnetDockerTags } from '../../docker.js';

import desiredRebalancerBalances from './balances/desiredRebalancerBalances.json' with { type: 'json' };
import desiredInventoryRebalancerBalances from './balances/desiredInventoryRebalancerBalances.json' with { type: 'json' };
import desiredStableswapInventoryRebalancerBalances from './balances/desiredStableswapInventoryRebalancerBalances.json' with { type: 'json' };
import desiredRelayerBalances from './balances/desiredRelayerBalances.json' with { type: 'json' };
import lowUrgencyKeyFunderBalances from './balances/lowUrgencyKeyFunderBalance.json' with { type: 'json' };
import { environment } from './chains.js';
import { mainnet3SupportedChainNames } from './supportedChainNames.js';

type DesiredRelayerBalanceChains = keyof typeof desiredRelayerBalances;
const desiredRelayerBalancePerChain = Object.fromEntries(
  Object.entries(desiredRelayerBalances).map(([chain, balance]) => [
    chain,
    balance.toString(),
  ]),
) as Record<DesiredRelayerBalanceChains, string>;

type DesiredRebalancerBalanceChains = keyof typeof desiredRebalancerBalances;
const desiredRebalancerBalancePerChain = objMap(
  desiredRebalancerBalances,
  (_, balance) => balance.toString(),
) as Record<DesiredRebalancerBalanceChains, string>;

type DesiredInventoryRebalancerBalanceChains =
  keyof typeof desiredInventoryRebalancerBalances;
const desiredInventoryRebalancerBalancePerChain = objMap(
  desiredInventoryRebalancerBalances,
  (_, balance) => balance.toString(),
) as Record<DesiredInventoryRebalancerBalanceChains, string>;

type DesiredStableswapInventoryRebalancerBalanceChains =
  keyof typeof desiredStableswapInventoryRebalancerBalances;
const desiredStableswapInventoryRebalancerBalancePerChain = objMap(
  desiredStableswapInventoryRebalancerBalances,
  (_, balance) => balance.toString(),
) as Record<DesiredStableswapInventoryRebalancerBalanceChains, string>;

type LowUrgencyKeyFunderBalanceChains =
  keyof typeof lowUrgencyKeyFunderBalances;
const lowUrgencyKeyFunderBalancePerChain = objMap(
  lowUrgencyKeyFunderBalances,
  (_, balance) => balance.toString(),
) as Record<LowUrgencyKeyFunderBalanceChains, string>;

export const keyFunderConfig: KeyFunderConfig<
  typeof mainnet3SupportedChainNames
> = {
  docker: {
    repo: DockerImageRepos.NODE_SERVICES,
    tag: mainnetDockerTags.keyFunder,
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
    [Contexts.Hyperlane]: [
      Role.Relayer,
      Role.Rebalancer,
      Role.InventoryRebalancer,
      Role.StableswapInventoryRebalancer,
    ],
    [Contexts.ReleaseCandidate]: [Role.Relayer],
    [Contexts.FastPath]: [Role.Relayer],
  },
  chainsToSkip: ['mocachain'],
  // desired balance config, must be set for each chain
  desiredBalancePerChain: desiredRelayerBalancePerChain,
  // desired rebalancer balance config
  desiredRebalancerBalancePerChain,
  // desired inventory rebalancer balance config
  desiredInventoryRebalancerBalancePerChain,
  // desired stableswap inventory rebalancer balance config
  desiredStableswapInventoryRebalancerBalancePerChain,
  // if not set, keyfunder defaults to using desired balance * 0.2 as the threshold
  igpClaimThresholdPerChain: {
    arbitrum: '0.1',
    avalanche: '2',
    base: '0.1',
    blast: '0.1',
    bob: '0.1',
    bsc: '0.3',
    celo: '5',
    ethereum: '0.2',
    fraxtal: '0.1',
    gnosis: '5',
    linea: '0.1',
    lisk: '0.025',
    lukso: '10',
    mantle: '10',
    metis: '1',
    mode: '0.1',
    optimism: '0.1',
    polygon: '20',
    sei: '5',
    taiko: '0.1',
    viction: '2',
    worldchain: '0.1',
    xlayer: '0.25',
    // ignore non-evm chains
    eclipsemainnet: '0',
    solanamainnet: '0',
    soon: '0',
    sonicsvm: '0',
  },
  // Low urgency key funder balance thresholds for sweep calculations
  // Automatic sweep enabled by default for all chains with these thresholds
  // Defaults: sweep to 0x478be6076f31E9666123B9721D0B6631baD944AF when balance > 2x threshold, leave 1.5x threshold
  lowUrgencyKeyFunderBalances: lowUrgencyKeyFunderBalancePerChain,
  // Per-chain overrides for sweep (optional)
  sweepOverrides: {},
};
